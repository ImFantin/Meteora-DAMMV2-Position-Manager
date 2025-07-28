import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { CpAmm, getUnClaimReward } from '@meteora-ag/cp-amm-sdk';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import BN from 'bn.js';
import { JupiterClient } from './jupiter-client.js';

export interface Position {
    publicKey: PublicKey;
    account: any;
    feeOwedA: number;
    feeOwedB: number;
    depositA: number; // Token A deposit amount
    depositB: number; // Token B deposit amount
    positionNftAccount?: PublicKey; // The NFT account for this position
}

export interface PoolInfo {
    publicKey: PublicKey;
    tokenAMint: PublicKey;
    tokenBMint: PublicKey;
    account: any;
}

export class MeteoraClient {
    private connection: Connection;
    private cpAmm: CpAmm;
    private jupiterClient: JupiterClient;

    constructor(connection: Connection) {
        this.connection = connection;
        this.cpAmm = new CpAmm(connection);
        this.jupiterClient = new JupiterClient(connection);
    }

    // Helper method to detect the correct token program for a mint
    async getTokenProgram(mint: PublicKey): Promise<PublicKey> {
        try {
            const mintInfo = await this.connection.getAccountInfo(mint);
            if (!mintInfo) {
                return TOKEN_PROGRAM_ID; // Default fallback
            }

            // Check if the mint is owned by Token-2022 program
            if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
                return TOKEN_2022_PROGRAM_ID;
            }

            // Default to legacy token program
            return TOKEN_PROGRAM_ID;
        } catch (error) {
            console.log(`   ⚠️ Could not detect token program for ${mint.toString().slice(0, 8)}..., using default`);
            return TOKEN_PROGRAM_ID; // Default fallback
        }
    }

    async getPoolInfo(poolAddress: PublicKey): Promise<PoolInfo | null> {
        try {
            const poolState = await this.cpAmm.fetchPoolState(poolAddress);
            if (!poolState) return null;

            return {
                publicKey: poolAddress,
                tokenAMint: poolState.tokenAMint,
                tokenBMint: poolState.tokenBMint,
                account: poolState
            };
        } catch (error) {
            console.error('Error fetching pool info:', error);
            return null;
        }
    }

    // Helper method to calculate current fee rate as percentage
    async getCurrentFeeRate(poolState: any): Promise<number> {
        try {
            // Check for poolFees object (this is where the fee config is stored)
            if (poolState.poolFees && poolState.poolFees.baseFee) {
                const baseFee = poolState.poolFees.baseFee;
                
                const cliffFeeNumerator = Number(baseFee.cliffFeeNumerator || 0);
                const numberOfPeriod = baseFee.numberOfPeriod || 0;
                const reductionFactor = Number(baseFee.reductionFactor || 0);
                const periodFrequency = Number(baseFee.periodFrequency || 1);
                const feeSchedulerMode = baseFee.feeSchedulerMode || 0;
                
                // Calculate elapsed periods
                const activationPoint = Number(poolState.activationPoint || 0);
                let elapsedPeriods = 0;
                
                if (activationPoint > 1000000000) {
                    // It's a timestamp
                    const currentTimestamp = Math.floor(Date.now() / 1000);
                    const elapsedTime = currentTimestamp - activationPoint;
                    elapsedPeriods = periodFrequency > 0 ? Math.floor(elapsedTime / periodFrequency) : 0;
                } else {
                    // It's a slot number
                    const currentSlot = await this.connection.getSlot();
                    const elapsedSlots = currentSlot - activationPoint;
                    elapsedPeriods = periodFrequency > 0 ? Math.floor(elapsedSlots / periodFrequency) : 0;
                }
                
                // Cap elapsed periods to the maximum number of periods
                const effectivePeriods = Math.min(elapsedPeriods, numberOfPeriod);
                
                // Calculate current fee based on scheduler mode
                let currentFeeNumerator = cliffFeeNumerator;
                if (feeSchedulerMode === 0) { // Linear
                    currentFeeNumerator = Math.max(0, cliffFeeNumerator - (effectivePeriods * reductionFactor));
                } else if (feeSchedulerMode === 1) { // Exponential
                    const reductionRate = reductionFactor / 10000;
                    currentFeeNumerator = cliffFeeNumerator * Math.pow(1 - reductionRate, effectivePeriods);
                } else {
                    // Unknown fee scheduler mode - log warning and use cliff fee as fallback
                    console.log(`   ⚠️ Unknown fee scheduler mode: ${feeSchedulerMode}, using cliff fee rate`);
                    currentFeeNumerator = cliffFeeNumerator;
                }
                
                // Convert to percentage using the correct denominator (1 billion)
                const FEE_DENOMINATOR = 1000000000;
                const feePercentage = (currentFeeNumerator / FEE_DENOMINATOR) * 100;
                
                return Math.max(0, feePercentage);
            } else {
                // No fee schedule found, return a moderate fee rate as fallback
                return 25;
            }
            
        } catch (error) {
            console.log(`   ⚠️ Could not calculate current fee rate: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return 25; // Return moderate fee rate as fallback
        }
    }

    // Helper method to check if pool is eligible for closing based on fee rate
    async isPoolEligibleForClosing(poolAddress: PublicKey, maxFeeRate: number = 20): Promise<boolean> {
        try {
            const poolState = await this.cpAmm.fetchPoolState(poolAddress);
            const currentFeeRate = await this.getCurrentFeeRate(poolState);
            
            console.log(`   📊 Pool fee rate: ${currentFeeRate.toFixed(2)}% (max allowed: ${maxFeeRate}%)`);
            
            return currentFeeRate <= maxFeeRate;
        } catch (error) {
            console.log(`   ⚠️ Could not check pool eligibility: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false; // Don't close if we can't determine eligibility
        }
    }

    async getUserPositions(userPublicKey: PublicKey, poolAddress?: PublicKey): Promise<Position[]> {
        try {
            let userPositions;

            if (poolAddress) {
                // Use getUserPositionByPool for more efficient filtering
                userPositions = await this.cpAmm.getUserPositionByPool(poolAddress, userPublicKey);
            } else {
                // Use getPositionsByUser to get all user positions across all pools
                userPositions = await this.cpAmm.getPositionsByUser(userPublicKey);
            }

            // Add delay after fetching positions to avoid overwhelming RPC
            await new Promise(resolve => setTimeout(resolve, 200));

            if (!userPositions || userPositions.length === 0) {
                return [];
            }

            const positions: Position[] = [];

            for (const positionInfo of userPositions) {
                try {
                    const position = positionInfo.positionState;
                    const positionPubkey = positionInfo.position;

                    // Get the pool state to calculate unclaimed fees
                    const poolState = await this.cpAmm.fetchPoolState(position.pool);
                    if (!poolState) {
                        console.warn(`Could not fetch pool state for position ${positionPubkey.toString().slice(0, 8)}`);
                        continue;
                    }

                    // Calculate actual claimable fees using the SDK helper function
                    const unclaimedFees = getUnClaimReward(poolState, position);
                    const rawFeeOwedA = unclaimedFees.feeTokenA.toNumber();
                    const rawFeeOwedB = unclaimedFees.feeTokenB.toNumber();

                    // Use getWithdrawQuote to get token amounts from position (working approach)
                    const { depositA, depositB } = await this.getPositionTokenAmounts(position, poolState);
                    
                    const SOL_MINT = this.jupiterClient.getSOLMint();
                    
                    // Convert fees to SOL equivalent (in lamports for consistency)
                    let feeOwedAInLamports = 0;
                    let feeOwedBInLamports = 0;
                    
                    // Convert Token A fees to SOL equivalent
                    if (rawFeeOwedA > 0) {
                        if (poolState.tokenAMint.toString() === SOL_MINT) {
                            feeOwedAInLamports = rawFeeOwedA; // Already in lamports
                        } else {
                            // For non-SOL tokens, skip conversion to avoid decimal issues
                            // This prevents the large number problem
                            feeOwedAInLamports = 0;
                        }
                    }
                    
                    // Convert Token B fees to SOL equivalent  
                    if (rawFeeOwedB > 0) {
                        if (poolState.tokenBMint.toString() === SOL_MINT) {
                            feeOwedBInLamports = rawFeeOwedB; // Already in lamports
                        } else {
                            // For non-SOL tokens, skip conversion to avoid decimal issues
                            feeOwedBInLamports = 0;
                        }
                    }
                    
                    // Convert deposits to SOL equivalent
                    let depositBInSOL = 0;
                    if (poolState.tokenBMint.toString() === SOL_MINT) {
                        depositBInSOL = depositB / 1e9;
                    } else {
                        try {
                            const quote = await this.jupiterClient.getQuote(poolState.tokenBMint.toString(), SOL_MINT, depositB, 50);
                            if (quote) depositBInSOL = parseInt(quote.outAmount) / 1e9;
                        } catch {}
                    }
                    
                    // Only count Token A deposits if it's actually SOL (avoid conversion issues)
                    let depositAInSOL = 0;
                    if (poolState.tokenAMint.toString() === SOL_MINT && depositA > 0) {
                        depositAInSOL = depositA / 1e9;
                    }

                    // Increased delay between position processing to respect RPC limits
                    await new Promise(resolve => setTimeout(resolve, 150));

                    positions.push({
                        publicKey: positionPubkey,
                        account: position,
                        feeOwedA: feeOwedAInLamports, // Store as lamports for consistency
                        feeOwedB: feeOwedBInLamports, // Store as lamports for consistency
                        depositA: depositAInSOL, // Store as SOL equivalent
                        depositB: depositBInSOL, // Store as SOL equivalent
                        positionNftAccount: positionInfo.positionNftAccount // Store the NFT account for later use
                    });
                } catch (positionError) {
                    console.warn('Error processing position:', positionError);
                    continue;
                }
            }

            return positions;
        } catch (error) {
            console.error('Error fetching user positions:', error);
            return [];
        }
    }

    async claimFees(
        userKeypair: Keypair,
        poolAddress: PublicKey,
        positionAddress: PublicKey,
        positionNftAccount?: PublicKey
    ): Promise<string> {
        try {
            console.log(`🔄 Claiming fees...`);

            // Get required state data
            const poolState = await this.cpAmm.fetchPoolState(poolAddress);
            const positionState = await this.cpAmm.fetchPositionState(positionAddress);

            if (!poolState || !positionState) {
                throw new Error('Could not fetch pool or position state');
            }

            // Small delay to avoid overwhelming RPC with rapid requests
            await new Promise(resolve => setTimeout(resolve, 100));

            // Position state retrieved

            // Use the provided positionNftAccount or calculate it from the NFT mint
            let finalPositionNftAccount: PublicKey;

            if (positionNftAccount) {
                finalPositionNftAccount = positionNftAccount;
            } else {
                finalPositionNftAccount = getAssociatedTokenAddressSync(
                    positionState.nftMint,
                    userKeypair.publicKey
                );
            }

            // Check if the position NFT account exists and find all token accounts for this mint
            let nftAccountInfo = null;
            let tokenAccounts: any = { value: [] };
            let finalNftAccount = finalPositionNftAccount;

            try {
                nftAccountInfo = await this.connection.getAccountInfo(finalPositionNftAccount);

                if (!nftAccountInfo) {
                    tokenAccounts = await this.connection.getTokenAccountsByOwner(userKeypair.publicKey, {
                        mint: positionState.nftMint
                    });


                    for (const account of tokenAccounts.value) {
                        try {
                            const accountData = account.account.data;
                            if (accountData.length >= 32) {
                                const ownerBytes = accountData.slice(32, 64);
                                const owner = new PublicKey(ownerBytes);

                                if (owner.equals(userKeypair.publicKey)) {
                                    finalNftAccount = account.pubkey;
                                    break;
                                }
                            }
                        } catch (parseError) {
                            // Skip invalid account data
                        }
                    }

                    if (tokenAccounts.value.length === 0) {
                        finalNftAccount = finalPositionNftAccount;
                    }
                }
            } catch (e) {
                // Use calculated NFT account if error occurs
            }

            // Detect correct token programs for each mint
            const tokenAProgram = await this.getTokenProgram(poolState.tokenAMint);
            const tokenBProgram = await this.getTokenProgram(poolState.tokenBMint);

            // Try using claimPositionFee method from the SDK with correct parameters
            const transaction = await this.cpAmm.claimPositionFee({
                owner: userKeypair.publicKey,
                pool: poolAddress,
                position: positionAddress,
                positionNftAccount: finalNftAccount,
                tokenAVault: poolState.tokenAVault,
                tokenBVault: poolState.tokenBVault,
                tokenAMint: poolState.tokenAMint,
                tokenBMint: poolState.tokenBMint,
                tokenAProgram: tokenAProgram,
                tokenBProgram: tokenBProgram
            });

            // Transaction created

            // Set transaction properties
            transaction.feePayer = userKeypair.publicKey;
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;

            // Sign the transaction
            transaction.sign(userKeypair);

            // Send the transaction
            const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed'
            });

            // Small delay before confirmation to reduce RPC load
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Wait for confirmation
            const confirmation = await this.connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight: (await this.connection.getLatestBlockhash()).lastValidBlockHeight
            });

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${confirmation.value.err}`);
            }

            console.log(`✅ Fees claimed successfully`);
            return signature;

        } catch (error) {
            console.error('Error in claimFees:', error);

            // If the first method fails, try the alternative method
            try {
                // Try alternative claim method
                const poolState2 = await this.cpAmm.fetchPoolState(poolAddress);
                const positionState2 = await this.cpAmm.fetchPositionState(positionAddress);

                if (!poolState2 || !positionState2) {
                    throw new Error('Could not fetch pool or position state for alternative method');
                }

                const positionNftAccount2 = getAssociatedTokenAddressSync(
                    positionState2.nftMint,
                    userKeypair.publicKey
                );

                // Calculate NFT account for alternative method

                // Detect correct token programs for alternative method
                const tokenAProgram2 = await this.getTokenProgram(poolState2.tokenAMint);
                const tokenBProgram2 = await this.getTokenProgram(poolState2.tokenBMint);

                const transaction2 = await this.cpAmm.claimPositionFee2({
                    owner: userKeypair.publicKey,
                    receiver: userKeypair.publicKey,
                    pool: poolAddress,
                    position: positionAddress,
                    positionNftAccount: positionNftAccount2,
                    tokenAVault: poolState2.tokenAVault,
                    tokenBVault: poolState2.tokenBVault,
                    tokenAMint: poolState2.tokenAMint,
                    tokenBMint: poolState2.tokenBMint,
                    tokenAProgram: tokenAProgram2,
                    tokenBProgram: tokenBProgram2
                });

                // Alternative transaction created

                transaction2.feePayer = userKeypair.publicKey;
                const { blockhash: blockhash2 } = await this.connection.getLatestBlockhash();
                transaction2.recentBlockhash = blockhash2;
                transaction2.sign(userKeypair);

                const signature2 = await this.connection.sendRawTransaction(transaction2.serialize(), {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed'
                });

                const confirmation2 = await this.connection.confirmTransaction({
                    signature: signature2,
                    blockhash: blockhash2,
                    lastValidBlockHeight: (await this.connection.getLatestBlockhash()).lastValidBlockHeight
                });

                if (confirmation2.value.err) {
                    throw new Error(`Transaction failed: ${confirmation2.value.err}`);
                }

                console.log(`✅ Fees claimed successfully`);
                return signature2;

            } catch (error2) {
                throw new Error(`Failed to claim fees with both methods: ${error instanceof Error ? error.message : 'Unknown error'} | ${error2 instanceof Error ? error2.message : 'Unknown error'}`);
            }
        }
    }

    async removeAllLiquidity(
        userKeypair: Keypair,
        poolAddress: PublicKey,
        positionAddress: PublicKey,
        positionNftAccount: PublicKey
    ): Promise<string> {
        try {
            console.log(`Removing all liquidity from position: ${positionAddress.toString()}`);

            // Get position and pool states
            const positionState = await this.cpAmm.fetchPositionState(positionAddress);
            const poolState = await this.cpAmm.fetchPoolState(poolAddress);

            if (!positionState || !poolState) {
                throw new Error('Could not fetch pool or position state');
            }

            // Check if position has liquidity
            const totalLiquidity = positionState.unlockedLiquidity.add(positionState.vestedLiquidity);
            if (totalLiquidity.isZero()) {
                throw new Error('Position has no liquidity to remove');
            }

            // Liquidity amount calculated

            // Detect correct token programs
            const tokenAProgram = await this.getTokenProgram(poolState.tokenAMint);
            const tokenBProgram = await this.getTokenProgram(poolState.tokenBMint);

            // Build remove all liquidity transaction
            const removeLiquidityTx = await this.cpAmm.removeAllLiquidity({
                owner: userKeypair.publicKey,
                pool: poolAddress,
                position: positionAddress,
                positionNftAccount: positionNftAccount,
                tokenAAmountThreshold: new BN(0), // Accept any amount (no slippage protection)
                tokenBAmountThreshold: new BN(0), // Accept any amount (no slippage protection)
                tokenAMint: poolState.tokenAMint,
                tokenBMint: poolState.tokenBMint,
                tokenAVault: poolState.tokenAVault,
                tokenBVault: poolState.tokenBVault,
                tokenAProgram: tokenAProgram,
                tokenBProgram: tokenBProgram,
                vestings: [], // Empty array for vesting accounts
                currentPoint: new BN(await this.connection.getSlot()), // Current slot
            });

            const transaction = removeLiquidityTx;

            // Set transaction properties
            transaction.feePayer = userKeypair.publicKey;
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;

            // Sign and send transaction
            transaction.sign(userKeypair);
            const signature = await this.connection.sendTransaction(transaction, [userKeypair], {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
            });

            // Wait for confirmation with proper blockhash
            const latestBlockhash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }, 'confirmed');
            console.log(`✅ Liquidity removed successfully`);

            return signature;
        } catch (error) {
            console.error('Error removing liquidity:', error);
            throw error;
        }
    }

    async closePosition(
        userKeypair: Keypair,
        poolAddress: PublicKey,
        positionAddress: PublicKey,
        positionNftAccount: PublicKey
    ): Promise<string> {
        try {
            console.log(`Closing position: ${positionAddress.toString()}`);

            // Get position state to verify it has no liquidity
            const positionState = await this.cpAmm.fetchPositionState(positionAddress);

            if (!positionState) {
                throw new Error('Could not fetch position state');
            }

            // Check if position has any liquidity
            const totalLiquidity = positionState.unlockedLiquidity
                .add(positionState.vestedLiquidity)
                .add(positionState.permanentLockedLiquidity);

            if (!totalLiquidity.isZero()) {
                throw new Error('Position still has liquidity. Remove all liquidity first.');
            }

            // Position has no liquidity

            // Build close position transaction
            const closePositionTx = await this.cpAmm.closePosition({
                owner: userKeypair.publicKey,
                pool: poolAddress,
                position: positionAddress,
                positionNftMint: positionState.nftMint,
                positionNftAccount: positionNftAccount,
            });

            const transaction = closePositionTx;

            // Set transaction properties
            transaction.feePayer = userKeypair.publicKey;
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;

            // Sign and send transaction
            transaction.sign(userKeypair);
            const signature = await this.connection.sendTransaction(transaction, [userKeypair], {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
            });

            // Wait for confirmation
            await this.connection.confirmTransaction(signature, 'confirmed');
            console.log(`✅ Position closed successfully`);

            return signature;
        } catch (error) {
            console.error('Error closing position:', error);
            throw error;
        }
    }

    async removeAllLiquidityAndClosePosition(
        userKeypair: Keypair,
        poolAddress: PublicKey,
        positionAddress: PublicKey,
        positionNftAccount: PublicKey
    ): Promise<string> {
        try {
            console.log(`Removing all liquidity and closing position: ${positionAddress.toString()}`);

            // Get position and pool states
            const positionState = await this.cpAmm.fetchPositionState(positionAddress);
            const poolState = await this.cpAmm.fetchPoolState(poolAddress);

            if (!positionState || !poolState) {
                throw new Error('Could not fetch pool or position state');
            }

            // Check if position is locked
            if (this.cpAmm.isLockedPosition(positionState)) {
                throw new Error('Cannot close a locked position');
            }

            // Get current slot for vesting calculations
            const currentSlot = await this.connection.getSlot();

            // Build remove all liquidity and close position transaction
            const tx = await this.cpAmm.removeAllLiquidityAndClosePosition({
                owner: userKeypair.publicKey,
                position: positionAddress,
                positionNftAccount: positionNftAccount,
                positionState: positionState,
                poolState: poolState,
                tokenAAmountThreshold: new BN(0), // Accept any amount (no slippage protection)
                tokenBAmountThreshold: new BN(0), // Accept any amount (no slippage protection)
                currentPoint: new BN(currentSlot),
                vestings: [], // Empty array for vesting accounts
            });

            const transaction = tx;

            // Set transaction properties
            transaction.feePayer = userKeypair.publicKey;
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;

            // Sign and send transaction
            transaction.sign(userKeypair);
            const signature = await this.connection.sendTransaction(transaction, [userKeypair], {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
            });

            // Wait for confirmation
            await this.connection.confirmTransaction(signature, 'confirmed');
            console.log(`✅ Position closed successfully`);

            return signature;
        } catch (error) {
            console.error('Error removing liquidity and closing position:', error);
            throw error;
        }
    }

    async claimFeesAndSwap(
        userKeypair: Keypair,
        poolAddress: PublicKey,
        positionAddress: PublicKey,
        positionNftAccount: PublicKey,
        swapToSOL: boolean = false,
        slippageBps: number = 10
    ): Promise<{ claimSignature: string; swapResults?: any[] }> {
        try {
            console.log(`Claiming fees for position: ${positionAddress.toString()}`);

            // First claim the fees
            const claimSignature = await this.claimFees(
                userKeypair,
                poolAddress,
                positionAddress,
                positionNftAccount
            );

            if (!swapToSOL) {
                return { claimSignature };
            }

            console.log('✅ Fees claimed, now checking for tokens to swap...');

            // Wait a moment for the claim transaction to settle
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Get pool info to know which tokens we might have received
            const poolState = await this.cpAmm.fetchPoolState(poolAddress);
            if (!poolState) {
                throw new Error('Could not fetch pool state');
            }

            const swapResults: any[] = [];
            const SOL_MINT = this.jupiterClient.getSOLMint();

            // Check and swap Token A if it's not SOL
            if (this.jupiterClient.isSwappableToken(poolState.tokenAMint.toString())) {
                try {
                    const tokenAAccount = getAssociatedTokenAddressSync(
                        poolState.tokenAMint,
                        userKeypair.publicKey
                    );

                    const accountInfo = await getAccount(this.connection, tokenAAccount);
                    const balance = Number(accountInfo.amount);

                    if (balance > 0) {
                        console.log(`🔄 Swapping Token A to SOL...`);

                        // Get quote first
                        const quote = await this.jupiterClient.getQuote(
                            poolState.tokenAMint.toString(),
                            SOL_MINT,
                            balance,
                            slippageBps
                        );

                        // Check if token is worth swapping
                        const worthSwapping = await this.jupiterClient.isWorthSwapping(
                            poolState.tokenAMint.toString(),
                            balance,
                            150000 // $0.15 minimum
                        );

                        if (!worthSwapping) {
                            console.log(`   ⏭️ Skipping Token A swap (below $0.15 threshold)`);
                            swapResults.push({
                                token: 'A',
                                mint: poolState.tokenAMint.toString(),
                                success: false,
                                error: 'Below minimum value threshold',
                                skipped: true
                            });
                        } else if (quote) {
                            console.log(`   📊 Token A quote: ${quote.inAmount} → ${quote.outAmount} (${quote.priceImpactPct}% impact)`);

                            const swapResult = await this.jupiterClient.swap(userKeypair, quote);
                            swapResults.push({
                                token: 'A',
                                mint: poolState.tokenAMint.toString(),
                                ...swapResult
                            });

                            if (swapResult.success) {
                                console.log(`   ✅ Token A swap successful! Signature: ${swapResult.signature}`);
                            } else {
                                console.log(`   ❌ Token A swap failed: ${swapResult.error}`);
                            }
                        } else {
                            console.log(`   ⚠️ Could not get quote for Token A`);
                        }
                    }
                } catch (error) {
                    console.log(`   ⚠️ Token A swap error: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    swapResults.push({
                        token: 'A',
                        mint: poolState.tokenAMint.toString(),
                        success: false,
                        error: error instanceof Error ? error.message : 'Unknown error'
                    });
                }
            }

            // Check and swap Token B if it's not SOL
            if (this.jupiterClient.isSwappableToken(poolState.tokenBMint.toString())) {
                try {
                    const tokenBAccount = getAssociatedTokenAddressSync(
                        poolState.tokenBMint,
                        userKeypair.publicKey
                    );

                    const accountInfo = await getAccount(this.connection, tokenBAccount);
                    const balance = Number(accountInfo.amount);

                    if (balance > 0) {
                        console.log(`🔄 Swapping Token B to SOL...`);

                        // Get quote first
                        const quote = await this.jupiterClient.getQuote(
                            poolState.tokenBMint.toString(),
                            SOL_MINT,
                            balance,
                            slippageBps
                        );

                        // Check if token is worth swapping
                        const worthSwapping = await this.jupiterClient.isWorthSwapping(
                            poolState.tokenBMint.toString(),
                            balance,
                            150000 // $0.15 minimum
                        );

                        if (!worthSwapping) {
                            console.log(`   ⏭️ Skipping Token B swap (below $0.15 threshold)`);
                            swapResults.push({
                                token: 'B',
                                mint: poolState.tokenBMint.toString(),
                                success: false,
                                error: 'Below minimum value threshold',
                                skipped: true
                            });
                        } else if (quote) {
                            console.log(`   📊 Token B quote: ${quote.inAmount} → ${quote.outAmount} (${quote.priceImpactPct}% impact)`);

                            const swapResult = await this.jupiterClient.swap(userKeypair, quote);
                            swapResults.push({
                                token: 'B',
                                mint: poolState.tokenBMint.toString(),
                                ...swapResult
                            });

                            if (swapResult.success) {
                                console.log(`   ✅ Token B swap successful! Signature: ${swapResult.signature}`);
                            } else {
                                console.log(`   ❌ Token B swap failed: ${swapResult.error}`);
                            }
                        } else {
                            console.log(`   ⚠️ Could not get quote for Token B`);
                        }
                    }
                } catch (error) {
                    console.log(`   ⚠️ Token B swap error: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    swapResults.push({
                        token: 'B',
                        mint: poolState.tokenBMint.toString(),
                        success: false,
                        error: error instanceof Error ? error.message : 'Unknown error'
                    });
                }
            }

            return { claimSignature, swapResults };

        } catch (error) {
            console.error('Error in claimFeesAndSwap:', error);
            throw error;
        }
    }

    async getPositionState(positionAddress: PublicKey): Promise<any | null> {
        try {
            return await this.cpAmm.fetchPositionState(positionAddress);
        } catch (error) {
            console.error('Error fetching position state:', error);
            return null;
        }
    }

    async swapTokensToSOL(
        userKeypair: Keypair,
        tokenMints: string[],
        slippageBps: number = 10,
        minValueLamports: number = 150000 // ~$0.15 USD minimum
    ): Promise<any[]> {
        const swapResults: any[] = [];
        const SOL_MINT = this.jupiterClient.getSOLMint();

        for (const tokenMint of tokenMints) {
            if (!this.jupiterClient.isSwappableToken(tokenMint)) {
                console.log(`   ⚠️ Skipping ${tokenMint.slice(0, 8)}... (already SOL)`);
                continue;
            }

            try {
                const tokenAccount = getAssociatedTokenAddressSync(
                    new PublicKey(tokenMint),
                    userKeypair.publicKey
                );

                const accountInfo = await getAccount(this.connection, tokenAccount);
                const balance = Number(accountInfo.amount);

                if (balance > 0) {
                    console.log(`🔄 Checking ${balance} tokens (${tokenMint.slice(0, 8)}...) for swap...`);

                    // Check if the token is worth swapping
                    const worthSwapping = await this.jupiterClient.isWorthSwapping(
                        tokenMint,
                        balance,
                        minValueLamports
                    );

                    if (!worthSwapping) {
                        console.log(`   ⏭️ Skipping swap (below $0.15 threshold)`);
                        swapResults.push({
                            mint: tokenMint,
                            success: false,
                            error: 'Below minimum value threshold',
                            skipped: true
                        });
                        continue;
                    }

                    // Get quote again for the actual swap (we already got one in isWorthSwapping)
                    const quote = await this.jupiterClient.getQuote(
                        tokenMint,
                        SOL_MINT,
                        balance,
                        slippageBps
                    );

                    if (quote) {
                        console.log(`   📊 Final quote: ${quote.inAmount} → ${quote.outAmount} (${quote.priceImpactPct}% impact)`);

                        const swapResult = await this.jupiterClient.swap(userKeypair, quote);
                        swapResults.push({
                            mint: tokenMint,
                            ...swapResult
                        });

                        if (swapResult.success) {
                            console.log(`   ✅ Swap successful! Signature: ${swapResult.signature}`);
                        } else {
                            console.log(`   ❌ Swap failed: ${swapResult.error}`);
                        }
                    } else {
                        console.log(`   ⚠️ Could not get quote for token`);
                        swapResults.push({
                            mint: tokenMint,
                            success: false,
                            error: 'Could not get quote'
                        });
                    }
                } else {
                    console.log(`   ⚠️ No balance found for ${tokenMint.slice(0, 8)}...`);
                }
            } catch (error) {
                console.log(`   ⚠️ Error swapping token: ${error instanceof Error ? error.message : 'Unknown error'}`);
                swapResults.push({
                    mint: tokenMint,
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }

            if (tokenMints.indexOf(tokenMint) < tokenMints.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        return swapResults;
    }

    /**
     * Get token amounts from position using getWithdrawQuote
     */
    private async getPositionTokenAmounts(position: any, poolState: any): Promise<{ depositA: number; depositB: number }> {
        try {
            const totalLiquidity = position.unlockedLiquidity
                .add(position.vestedLiquidity)
                .add(position.permanentLockedLiquidity || new BN(0));

            if (totalLiquidity.isZero()) {
                return { depositA: 0, depositB: 0 };
            }

            const withdrawQuote = await this.cpAmm.getWithdrawQuote({
                liquidityDelta: totalLiquidity,
                sqrtPrice: poolState.sqrtPrice,
                maxSqrtPrice: poolState.sqrtMaxPrice,
                minSqrtPrice: poolState.sqrtMinPrice,
            });

            let depositA = 0;
            let depositB = 0;

            try {
                depositA = withdrawQuote.outAmountA.toNumber();
            } catch {
                const str = withdrawQuote.outAmountA.toString();
                if (str.length <= 15) depositA = parseInt(str);
            }

            try {
                depositB = withdrawQuote.outAmountB.toNumber();
            } catch {
                const str = withdrawQuote.outAmountB.toString();
                if (str.length <= 15) depositB = parseInt(str);
            }

            return { depositA, depositB };
        } catch {
            return { depositA: 0, depositB: 0 };
        }
    }

    /**
     * Convert token amounts to SOL using Jupiter
     */
    private async convertTokensToSOL(
        tokenAAmount: number,
        tokenBAmount: number,
        tokenAMint: any,
        tokenBMint: any
    ): Promise<{ depositAInSOL: number; depositBInSOL: number }> {
        const SOL_MINT = this.jupiterClient.getSOLMint();
        let depositAInSOL = 0;
        let depositBInSOL = 0;

        // Convert Token A
        if (tokenAAmount > 0) {
            if (tokenAMint.toString() === SOL_MINT) {
                depositAInSOL = tokenAAmount / 1e9;
            } else {
                try {
                    const quote = await this.jupiterClient.getQuote(tokenAMint.toString(), SOL_MINT, tokenAAmount, 50);
                    if (quote) depositAInSOL = parseInt(quote.outAmount) / 1e9;
                } catch {}
            }
        }

        // Convert Token B
        if (tokenBAmount > 0) {
            if (tokenBMint.toString() === SOL_MINT) {
                depositBInSOL = tokenBAmount / 1e9;
            } else {
                try {
                    const quote = await this.jupiterClient.getQuote(tokenBMint.toString(), SOL_MINT, tokenBAmount, 50);
                    if (quote) depositBInSOL = parseInt(quote.outAmount) / 1e9;
                } catch {}
            }
        }

        return { depositAInSOL, depositBInSOL };
    }

    /**
     * Get user's token balances for a pool and convert to SOL using Jupiter API
     */
    private async getTokenBalancesInSOL(
        userPublicKey: PublicKey,
        tokenAMint: any,
        tokenBMint: any
    ): Promise<{ depositAInSOL: number; depositBInSOL: number }> {
        try {
            const SOL_MINT = this.jupiterClient.getSOLMint();
            let depositAInSOL = 0;
            let depositBInSOL = 0;

            // Get Token A balance
            try {
                const tokenAAccount = getAssociatedTokenAddressSync(
                    tokenAMint,
                    userPublicKey
                );
                const accountInfoA = await getAccount(this.connection, tokenAAccount);
                const balanceA = Number(accountInfoA.amount);

                if (balanceA > 0) {
                    if (tokenAMint.toString() !== SOL_MINT) {
                        // Convert to SOL using Jupiter
                        const quoteA = await this.jupiterClient.getQuote(
                            tokenAMint.toString(),
                            SOL_MINT,
                            balanceA,
                            50
                        );
                        if (quoteA) {
                            depositAInSOL = parseInt(quoteA.outAmount) / 1e9;
                        }
                    } else {
                        depositAInSOL = balanceA / 1e9;
                    }
                }
            } catch {
                // Token account doesn't exist or other error
                depositAInSOL = 0;
            }

            // Get Token B balance
            try {
                const tokenBAccount = getAssociatedTokenAddressSync(
                    tokenBMint,
                    userPublicKey
                );
                const accountInfoB = await getAccount(this.connection, tokenBAccount);
                const balanceB = Number(accountInfoB.amount);

                if (balanceB > 0) {
                    if (tokenBMint.toString() !== SOL_MINT) {
                        // Convert to SOL using Jupiter
                        const quoteB = await this.jupiterClient.getQuote(
                            tokenBMint.toString(),
                            SOL_MINT,
                            balanceB,
                            50
                        );
                        if (quoteB) {
                            depositBInSOL = parseInt(quoteB.outAmount) / 1e9;
                        }
                    } else {
                        depositBInSOL = balanceB / 1e9;
                    }
                }
            } catch {
                // Token account doesn't exist or other error
                depositBInSOL = 0;
            }

            return { depositAInSOL, depositBInSOL };
        } catch (error) {
            // If conversion fails, return 0
            return { depositAInSOL: 0, depositBInSOL: 0 };
        }
    }



}