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
                    const feeOwedA = unclaimedFees.feeTokenA.toNumber();
                    const feeOwedB = unclaimedFees.feeTokenB.toNumber();



                    await new Promise(resolve => setTimeout(resolve, 50));

                    positions.push({
                        publicKey: positionPubkey,
                        account: position,
                        feeOwedA,
                        feeOwedB,
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

            // Wait for confirmation
            await this.connection.confirmTransaction(signature, 'confirmed');
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
}