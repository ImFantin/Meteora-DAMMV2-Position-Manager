#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import dotenv from 'dotenv';
import inquirer from 'inquirer';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { isValidPublicKey, isValidPrivateKey, retry } from './utils.js';
import { MeteoraClient } from './meteora-client.js';

// Load environment variables
dotenv.config();

const program = new Command();

interface ClaimResult {
  success: boolean;
  signature?: string;
  error?: string;
  feesA?: number;
  feesB?: number;
}

class MeteoraFeeClaimer {
  private connection: Connection;
  private wallet: Keypair;
  private meteoraClient: MeteoraClient;

  constructor() {
    // Initialize connection
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
      throw new Error('RPC_URL not found in environment variables');
    }
    this.connection = new Connection(rpcUrl, 'confirmed');

    // Initialize wallet
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('PRIVATE_KEY not found in environment variables');
    }

    if (!isValidPrivateKey(privateKey)) {
      throw new Error('Invalid private key format. Please provide a base58 encoded private key.');
    }

    try {
      const secretKey = bs58.decode(privateKey);
      this.wallet = Keypair.fromSecretKey(secretKey);
    } catch (error) {
      throw new Error('Failed to create wallet from private key.');
    }

    // Initialize Meteora client
    this.meteoraClient = new MeteoraClient(this.connection);
  }

  async getWalletInfo(): Promise<void> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    console.log(chalk.blue('🔑 Wallet Info:'));
    console.log(chalk.gray(`   Address: ${this.wallet.publicKey.toString()}`));
    console.log(chalk.gray(`   Balance: ${(balance / 1e9).toFixed(4)} SOL`));
    console.log();
  }

  async getPoolInfo(poolAddress: string) {
    if (!isValidPublicKey(poolAddress)) {
      throw new Error('Invalid pool address format');
    }

    try {
      const poolPubkey = new PublicKey(poolAddress);
      const poolInfo = await retry(() => this.meteoraClient.getPoolInfo(poolPubkey));

      if (!poolInfo) {
        throw new Error('Pool not found or invalid pool address');
      }

      return poolInfo;
    } catch (error) {
      throw new Error(`Failed to fetch pool info: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getUserPositions(poolAddress?: string) {
    try {
      const poolPubkey = poolAddress ? new PublicKey(poolAddress) : undefined;
      const positions = await this.meteoraClient.getUserPositions(this.wallet.publicKey, poolPubkey);
      return positions;
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Warning: Could not fetch user positions: ${error instanceof Error ? error.message : 'Unknown error'}`));
      return [];
    }
  }

  async claimFees(poolAddress: string, swapToSOL: boolean = false, slippageBps: number = 10): Promise<ClaimResult> {
    try {
      const poolPubkey = new PublicKey(poolAddress);

      // Get pool info
      await this.getPoolInfo(poolAddress);

      // Get user positions for this specific pool
      const positions = await this.getUserPositions(poolAddress);

      if (positions.length === 0) {
        return {
          success: false,
          error: 'No positions found for this pool'
        };
      }

      console.log(chalk.blue(`📊 Found ${positions.length} position(s) in pool`));

      let totalFeesA = 0;
      let totalFeesB = 0;
      let claimSignatures: string[] = [];

      for (const position of positions) {
        try {
          const claimableFeesA = position.feeOwedA || 0;
          const claimableFeesB = position.feeOwedB || 0;

          if (claimableFeesA > 0 || claimableFeesB > 0) {
            console.log(chalk.green(`💰 Claimable fees found for position ${position.publicKey.toString().slice(0, 8)}...`));

            if (swapToSOL) {
              const result = await this.meteoraClient.claimFeesAndSwap(
                this.wallet,
                poolPubkey,
                position.publicKey,
                position.positionNftAccount!,
                true,
                slippageBps
              );

              claimSignatures.push(result.claimSignature);
              totalFeesA += claimableFeesA;
              totalFeesB += claimableFeesB;

              console.log(chalk.green(`✅ Fees claimed! Signature: ${result.claimSignature}`));
              
              if (result.swapResults && result.swapResults.length > 0) {
                for (const swapResult of result.swapResults) {
                  if (swapResult.success) {
                    console.log(chalk.green(`✅ Token ${swapResult.token} swapped to SOL! Signature: ${swapResult.signature}`));
                  } else {
                    console.log(chalk.yellow(`⚠️ Token ${swapResult.token} swap failed: ${swapResult.error}`));
                  }
                }
              }
            } else {
              const signature = await this.meteoraClient.claimFees(
                this.wallet,
                poolPubkey,
                position.publicKey,
                position.positionNftAccount!
              );

              claimSignatures.push(signature);
              totalFeesA += claimableFeesA;
              totalFeesB += claimableFeesB;

              console.log(chalk.green(`✅ Fees claimed! Signature: ${signature}`));
            }
          } else {
            console.log(chalk.yellow(`⚠️  No claimable fees for position ${position.publicKey.toString().slice(0, 8)}...`));
          }
        } catch (positionError) {
          console.log(chalk.red(`❌ Failed to claim fees for position: ${positionError instanceof Error ? positionError.message : 'Unknown error'}`));
        }
      }

      if (claimSignatures.length > 0) {
        return {
          success: true,
          signature: claimSignatures[0],
          feesA: totalFeesA,
          feesB: totalFeesB
        };
      } else {
        return {
          success: false,
          error: 'No fees were available to claim'
        };
      }

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  async claimAllFees(swapToSOL: boolean = false, slippageBps: number = 10): Promise<ClaimResult> {
    try {
      console.log(chalk.blue('🔍 Scanning all positions for claimable fees...'));

      // Get all user positions across all pools
      const allPositions = await this.getUserPositions();

      if (allPositions.length === 0) {
        return {
          success: false,
          error: 'No positions found'
        };
      }

      console.log(chalk.blue(`📊 Found ${allPositions.length} total position(s)`));

      // Filter positions with claimable fees
      const positionsWithFees = allPositions.filter(position => {
        const claimableFeesA = position.feeOwedA || 0;
        const claimableFeesB = position.feeOwedB || 0;
        return claimableFeesA > 0 || claimableFeesB > 0;
      });

      if (positionsWithFees.length === 0) {
        return {
          success: false,
          error: 'No positions with claimable fees found'
        };
      }

      console.log(chalk.green(`💰 Found ${positionsWithFees.length} position(s) with claimable fees`));
      console.log();

      let totalFeesA = 0;
      let totalFeesB = 0;
      let successfulClaims = 0;
      let claimSignatures: string[] = [];

      // Process each position with fees
      for (let i = 0; i < positionsWithFees.length; i++) {
        const position = positionsWithFees[i];
        const positionId = position.publicKey.toString().slice(0, 8);
        const claimableFeesA = position.feeOwedA || 0;
        const claimableFeesB = position.feeOwedB || 0;

        try {
          console.log(chalk.blue(`\n[${i + 1}/${positionsWithFees.length}] Processing position ${positionId}...`));
          if (claimableFeesA > 0 || claimableFeesB > 0) {
            console.log(chalk.gray(`   Claimable fees: ${claimableFeesA > 0 ? claimableFeesA + ' (A) ' : ''}${claimableFeesB > 0 ? claimableFeesB + ' (B)' : ''}`));
          }

          if (!position.positionNftAccount) {
            console.log(chalk.red(`   ❌ No NFT account found for position ${positionId}`));
            continue;
          }

          if (swapToSOL) {
            const result = await this.meteoraClient.claimFeesAndSwap(
              this.wallet,
              position.account.pool,
              position.publicKey,
              position.positionNftAccount!,
              true,
              slippageBps
            );

            claimSignatures.push(result.claimSignature);
            totalFeesA += claimableFeesA;
            totalFeesB += claimableFeesB;
            successfulClaims++;

            console.log(chalk.green(`   ✅ Fees claimed! Signature: ${result.claimSignature}`));
            
            if (result.swapResults && result.swapResults.length > 0) {
              for (const swapResult of result.swapResults) {
                if (swapResult.success) {
                  console.log(chalk.green(`   ✅ Token ${swapResult.token} swapped to SOL! Signature: ${swapResult.signature}`));
                } else {
                  console.log(chalk.yellow(`   ⚠️ Token ${swapResult.token} swap failed: ${swapResult.error}`));
                }
              }
            }
          } else {
            const signature = await this.meteoraClient.claimFees(
              this.wallet,
              position.account.pool,
              position.publicKey,
              position.positionNftAccount!
            );

            claimSignatures.push(signature);
            totalFeesA += claimableFeesA;
            totalFeesB += claimableFeesB;
            successfulClaims++;

            console.log(chalk.green(`   ✅ Fees claimed! Signature: ${signature}`));
          }

          // Add a small delay between transactions to avoid rate limiting
          if (i < positionsWithFees.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }

        } catch (positionError) {
          console.log(chalk.red(`   ❌ Failed to claim fees: ${positionError instanceof Error ? positionError.message : 'Unknown error'}`));
        }
      }

      console.log(chalk.blue('\n📈 Summary:'));
      console.log(chalk.gray(`   Positions processed: ${positionsWithFees.length}`));
      console.log(chalk.gray(`   Successful claims: ${successfulClaims}`));
      console.log(chalk.gray(`   Failed claims: ${positionsWithFees.length - successfulClaims}`));

      if (successfulClaims > 0) {
        return {
          success: true,
          signature: claimSignatures[claimSignatures.length - 1], // Return the last signature
          feesA: totalFeesA,
          feesB: totalFeesB
        };
      } else {
        return {
          success: false,
          error: 'No fees were successfully claimed'
        };
      }

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  async runInteractiveMenu(): Promise<void> {
    console.log(chalk.blue.bold('\n🌊 Welcome to Meteora Fee Claimer & Position Manager'));
    console.log(chalk.gray('═'.repeat(60)));
    
    await this.getWalletInfo();
    
    while (true) {
      try {
        // Main menu
        const mainChoice = await inquirer.prompt([
          {
            type: 'list',
            name: 'action',
            message: 'What would you like to do?',
            choices: [
              { name: '💰 Claim/Close (Keep Original Tokens)', value: 'claim' },
              { name: '🔄 Claim/Close & Auto-Swap to SOL', value: 'claim-swap' },
              { name: '📊 View Position Summary', value: 'summary' },
              { name: '❌ Exit', value: 'exit' }
            ]
          }
        ]);

        if (mainChoice.action === 'exit') {
          console.log(chalk.green('\n👋 Goodbye!'));
          break;
        }

        if (mainChoice.action === 'summary') {
          await this.showSummary();
          continue;
        }

        const swapToSOL = mainChoice.action === 'claim-swap';

        // Secondary menu with different options based on swap choice
        const choices = swapToSOL ? [
          { name: '🎯 Claim Fees from Specific Pool → Swap to SOL', value: 'claim-pool' },
          { name: '🏠 Claim & Close Position from Specific Pool → Swap to SOL', value: 'close-pool' },
          { name: '🌟 Claim All Fees → Swap to SOL', value: 'claim-all' },
          { name: '🔥 Claim, Close & Swap All Positions → Convert Everything to SOL', value: 'close-all' },
          { name: '⬅️  Back to Main Menu', value: 'back' }
        ] : [
          { name: '🎯 Claim Fees from Specific Pool', value: 'claim-pool' },
          { name: '🏠 Claim & Close Position from Specific Pool', value: 'close-pool' },
          { name: '🌟 Claim All Fees (Keep Original Tokens)', value: 'claim-all' },
          { name: '🔥 Claim & Close All Positions (Keep Original Tokens)', value: 'close-all' },
          { name: '⬅️  Back to Main Menu', value: 'back' }
        ];

        const actionChoice = await inquirer.prompt([
          {
            type: 'list',
            name: 'operation',
            message: swapToSOL ? 'Choose operation (with automatic swap to SOL):' : 'Choose operation (keeping original tokens):',
            choices
          }
        ]);

        if (actionChoice.operation === 'back') {
          continue;
        }

        let slippageBps = 10;
        if (swapToSOL) {
          const slippageChoice = await inquirer.prompt([
            {
              type: 'input',
              name: 'slippage',
              message: 'Enter slippage tolerance in basis points (default: 10):',
              default: '10',
              validate: (input) => {
                const num = parseInt(input);
                if (isNaN(num) || num < 1 || num > 1000) {
                  return 'Please enter a number between 1 and 1000';
                }
                return true;
              }
            }
          ]);
          slippageBps = parseInt(slippageChoice.slippage);
        }

        // Execute the chosen operation
        await this.executeOperation(actionChoice.operation, swapToSOL, slippageBps);

        // Ask if user wants to continue
        const continueChoice = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'continue',
            message: 'Would you like to perform another operation?',
            default: true
          }
        ]);

        if (!continueChoice.continue) {
          console.log(chalk.green('\n👋 Goodbye!'));
          break;
        }

      } catch (error) {
        console.log(chalk.red(`\n❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
        
        const retryChoice = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'retry',
            message: 'Would you like to try again?',
            default: true
          }
        ]);

        if (!retryChoice.retry) {
          break;
        }
      }
    }
  }

  async executeOperation(operation: string, swapToSOL: boolean, slippageBps: number): Promise<void> {
    switch (operation) {
      case 'claim-pool':
        await this.handleClaimPool(swapToSOL, slippageBps);
        break;
      case 'close-pool':
        await this.handleClosePool(swapToSOL, slippageBps);
        break;
      case 'claim-all':
        await this.handleClaimAll(swapToSOL, slippageBps);
        break;
      case 'close-all':
        await this.handleCloseAll(swapToSOL, slippageBps);
        break;
    }
  }

  async handleClaimPool(swapToSOL: boolean, slippageBps: number): Promise<void> {
    const poolChoice = await inquirer.prompt([
      {
        type: 'input',
        name: 'poolAddress',
        message: 'Enter the pool address:',
        validate: (input) => {
          if (!isValidPublicKey(input)) {
            return 'Please enter a valid Solana public key';
          }
          return true;
        }
      }
    ]);

    const spinner = ora('Processing...').start();
    try {
      const result = await this.claimFees(poolChoice.poolAddress, swapToSOL, slippageBps);
      
      if (result.success) {
        spinner.succeed('Fees claimed successfully!');
        console.log(chalk.green('🎉 Success!'));
        console.log(chalk.gray(`   Transaction: ${result.signature}`));
        if (result.feesA && result.feesA > 0) {
          console.log(chalk.gray(`   Fees A claimed: ${result.feesA}`));
        }
        if (result.feesB && result.feesB > 0) {
          console.log(chalk.gray(`   Fees B claimed: ${result.feesB}`));
        }
      } else {
        spinner.fail('Failed to claim fees');
        console.log(chalk.red(`❌ Error: ${result.error}`));
      }
    } catch (error) {
      spinner.fail('Failed to claim fees');
      throw error;
    }
  }

  async handleClosePool(swapToSOL: boolean, slippageBps: number): Promise<void> {
    const poolChoice = await inquirer.prompt([
      {
        type: 'input',
        name: 'poolAddress',
        message: 'Enter the pool address:',
        validate: (input) => {
          if (!isValidPublicKey(input)) {
            return 'Please enter a valid Solana public key';
          }
          return true;
        }
      }
    ]);

    const spinner = ora('Processing...').start();
    try {
      const result = await this.closePosition(poolChoice.poolAddress, 'claim-and-close', swapToSOL, slippageBps);
      
      if (result.success) {
        spinner.succeed('Position closed successfully!');
        console.log(chalk.green('🎉 Success!'));
        console.log(chalk.gray(`   Final Transaction: ${result.signature}`));
        if (result.feesA && result.feesA > 0) {
          console.log(chalk.gray(`   Fees A claimed: ${result.feesA}`));
        }
        if (result.feesB && result.feesB > 0) {
          console.log(chalk.gray(`   Fees B claimed: ${result.feesB}`));
        }
      } else {
        spinner.fail('Failed to close position');
        console.log(chalk.red(`❌ Error: ${result.error}`));
      }
    } catch (error) {
      spinner.fail('Failed to close position');
      throw error;
    }
  }

  async handleClaimAll(swapToSOL: boolean, slippageBps: number): Promise<void> {
    const confirmChoice = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: swapToSOL ? 
          'This will claim ALL fees from ALL positions and swap tokens to SOL. Continue?' :
          'This will claim ALL fees from ALL positions. Continue?',
        default: false
      }
    ]);

    if (!confirmChoice.confirm) {
      console.log(chalk.yellow('Operation cancelled.'));
      return;
    }

    const spinner = ora('Processing all positions...').start();
    try {
      spinner.stop();
      const result = await this.claimAllFees(swapToSOL, slippageBps);
      
      if (result.success) {
        console.log(chalk.green('\n🎉 All fees claimed successfully!'));
        console.log(chalk.gray(`   Final Transaction: ${result.signature}`));
        if (result.feesA && result.feesA > 0) {
          console.log(chalk.gray(`   Total Fees A claimed: ${result.feesA}`));
        }
        if (result.feesB && result.feesB > 0) {
          console.log(chalk.gray(`   Total Fees B claimed: ${result.feesB}`));
        }
      } else {
        console.log(chalk.red(`❌ Error: ${result.error}`));
      }
    } catch (error) {
      spinner.fail('Failed to claim all fees');
      throw error;
    }
  }

  async handleCloseAll(swapToSOL: boolean, slippageBps: number): Promise<void> {
    // Get position count for confirmation
    const positions = await this.getUserPositions();
    const positionCount = positions.length;

    if (positionCount === 0) {
      console.log(chalk.yellow('No positions found.'));
      return;
    }

    console.log(chalk.red('⚠️  WARNING: This will close ALL your positions!'));
    console.log(chalk.yellow(`📊 Found ${positionCount} position(s) that will be processed`));
    console.log(chalk.gray('   • All fees will be claimed'));
    console.log(chalk.gray('   • All liquidity will be removed'));
    console.log(chalk.gray('   • All positions will be closed'));
    
    if (swapToSOL) {
      console.log(chalk.blue(`🔧 Swap to SOL: Enabled (${slippageBps} BPS slippage)`));
      console.log(chalk.gray('   • All received tokens will be swapped to SOL'));
    }
    
    console.log();

    const confirmChoice = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Are you absolutely sure you want to close ALL ${positionCount} positions?`,
        default: false
      }
    ]);

    if (!confirmChoice.confirm) {
      console.log(chalk.yellow('Operation cancelled.'));
      return;
    }

    console.log(chalk.blue('🚀 Processing positions...'));
    const result = await this.closeAllPositions(swapToSOL, slippageBps);

    if (result.success) {
      if (swapToSOL) {
        console.log(chalk.green('\n🎉 All positions closed and tokens swapped successfully!'));
      } else {
        console.log(chalk.green('\n🎉 All positions closed successfully!'));
      }
      console.log(chalk.gray(`   Final Transaction: ${result.signature}`));
      if (result.feesA && result.feesA > 0) {
        console.log(chalk.gray(`   Total Fees A claimed: ${result.feesA}`));
      }
      if (result.feesB && result.feesB > 0) {
        console.log(chalk.gray(`   Total Fees B claimed: ${result.feesB}`));
      }
    } else {
      console.log(chalk.red(`❌ Error: ${result.error}`));
    }
  }

  async showSummary(): Promise<void> {
    const spinner = ora('Fetching positions summary...').start();
    
    try {
      const positions = await this.getUserPositions();
      
      spinner.succeed(`Found ${positions.length} position(s)`);
      
      if (positions.length === 0) {
        console.log(chalk.yellow('No positions found.'));
        return;
      }
      
      // Calculate totals
      let totalFeesA = 0;
      let totalFeesB = 0;
      let positionsWithFees = 0;
      
      const positionsByPool = new Map<string, any[]>();
      
      for (const position of positions) {
        const poolAddress = position.account.pool.toString();
        if (!positionsByPool.has(poolAddress)) {
          positionsByPool.set(poolAddress, []);
        }
        positionsByPool.get(poolAddress)!.push(position);
        
        const feesA = position.feeOwedA || 0;
        const feesB = position.feeOwedB || 0;
        
        totalFeesA += feesA;
        totalFeesB += feesB;
        
        if (feesA > 0 || feesB > 0) {
          positionsWithFees++;
        }
      }
      
      console.log(chalk.blue('\n📊 Positions Summary:'));
      console.log('='.repeat(60));
      console.log(chalk.gray(`Total Positions: ${positions.length}`));
      console.log(chalk.gray(`Positions with Fees: ${positionsWithFees}`));
      console.log(chalk.gray(`Unique Pools: ${positionsByPool.size}`));
      console.log();
      
      if (totalFeesA > 0 || totalFeesB > 0) {
        console.log(chalk.green('💰 Total Claimable Fees:'));
        if (totalFeesA > 0) {
          console.log(chalk.gray(`   Token A fees: ${totalFeesA} lamports`));
        }
        if (totalFeesB > 0) {
          console.log(chalk.gray(`   Token B fees: ${totalFeesB} lamports (~${(totalFeesB / 1e9).toFixed(6)} SOL)`));
        }
      } else {
        console.log(chalk.yellow('No claimable fees found.'));
      }
      
    } catch (error) {
      spinner.fail('Failed to fetch positions summary');
      throw error;
    }
  }

  async closePosition(poolAddress: string, mode: 'claim-and-close' | 'remove-liquidity' | 'close-only' = 'claim-and-close', swapToSOL: boolean = false, slippageBps: number = 10): Promise<ClaimResult> {
    try {
      const poolPubkey = new PublicKey(poolAddress);

      // Get pool info
      await this.getPoolInfo(poolAddress);

      // Get user positions for this specific pool
      const positions = await this.getUserPositions(poolAddress);

      if (positions.length === 0) {
        return {
          success: false,
          error: 'No positions found for this pool'
        };
      }

      console.log(chalk.blue(`📊 Found ${positions.length} position(s) in pool`));

      let signatures: string[] = [];
      let totalFeesA = 0;
      let totalFeesB = 0;

      for (const position of positions) {
        try {
          const positionId = position.publicKey.toString().slice(0, 8);
          console.log(chalk.blue(`\n🔄 Processing position ${positionId}...`));

          if (!position.positionNftAccount) {
            console.log(chalk.red(`❌ No NFT account found for position ${positionId}`));
            continue;
          }

          // Step 1: Claim fees if there are any and mode allows it
          if (mode === 'claim-and-close') {
            const claimableFeesA = position.feeOwedA || 0;
            const claimableFeesB = position.feeOwedB || 0;

            if (claimableFeesA > 0 || claimableFeesB > 0) {
              console.log(chalk.green(`💰 Claiming fees for position ${positionId}...`));

              const claimSignature = await this.meteoraClient.claimFees(
                this.wallet,
                poolPubkey,
                position.publicKey,
                position.positionNftAccount
              );

              signatures.push(claimSignature);
              totalFeesA += claimableFeesA;
              totalFeesB += claimableFeesB;

              console.log(chalk.green(`✅ Fees claimed! Signature: ${claimSignature}`));
            }
          }

          // Step 2: Handle position closing based on mode
          if (mode === 'claim-and-close' || mode === 'remove-liquidity') {
            console.log(chalk.blue(`🔄 Removing all liquidity and closing position ${positionId}...`));
            
            // Get pool info to know which tokens we'll receive
            const poolInfo = await this.meteoraClient.getPoolInfo(poolPubkey);
            const tokenMints = poolInfo ? [
              poolInfo.tokenAMint.toString(),
              poolInfo.tokenBMint.toString()
            ] : [];
            
            const closeSignature = await this.meteoraClient.removeAllLiquidityAndClosePosition(
              this.wallet,
              poolPubkey,
              position.publicKey,
              position.positionNftAccount
            );

            signatures.push(closeSignature);
            console.log(chalk.green(`✅ Position closed! Signature: ${closeSignature}`));

            // Step 3: Swap tokens to SOL if requested
            if (swapToSOL && tokenMints.length > 0) {
              console.log(chalk.blue(`🔄 Swapping received tokens to SOL...`));
              
              // Wait for the close transaction to settle
              await new Promise(resolve => setTimeout(resolve, 500));
              
              const swapResults = await this.meteoraClient.swapTokensToSOL(
                this.wallet,
                tokenMints,
                slippageBps
              );
              
              for (const swapResult of swapResults) {
                if (swapResult.success) {
                  signatures.push(swapResult.signature);
                  console.log(chalk.green(`✅ Token swapped to SOL! Signature: ${swapResult.signature}`));
                } else {
                  console.log(chalk.yellow(`⚠️ Token swap failed: ${swapResult.error}`));
                }
              }
            }

          } else if (mode === 'close-only') {
            console.log(chalk.blue(`🔄 Closing position ${positionId} (liquidity must be zero)...`));
            
            const closeSignature = await this.meteoraClient.closePosition(
              this.wallet,
              poolPubkey,
              position.publicKey,
              position.positionNftAccount
            );

            signatures.push(closeSignature);
            console.log(chalk.green(`✅ Position closed! Signature: ${closeSignature}`));
          }

        } catch (positionError) {
          console.log(chalk.red(`❌ Failed to process position: ${positionError instanceof Error ? positionError.message : 'Unknown error'}`));
        }
      }

      if (signatures.length > 0) {
        return {
          success: true,
          signature: signatures[signatures.length - 1], // Return the last signature
          feesA: totalFeesA,
          feesB: totalFeesB
        };
      } else {
        return {
          success: false,
          error: 'No positions were processed successfully'
        };
      }

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  async closeAllPositions(swapToSOL: boolean = false, slippageBps: number = 10): Promise<ClaimResult> {
    try {
      console.log(chalk.blue('🔍 Scanning all positions for closing...'));

      // Get all user positions across all pools
      const allPositions = await this.getUserPositions();

      if (allPositions.length === 0) {
        return {
          success: false,
          error: 'No positions found'
        };
      }

      console.log(chalk.blue(`📊 Found ${allPositions.length} total position(s)`));
      console.log(chalk.yellow('⚠️  This will close ALL positions and remove ALL liquidity!'));
      console.log();

      let totalFeesA = 0;
      let totalFeesB = 0;
      let successfulOperations = 0;
      let allSignatures: string[] = [];

      // Process each position
      for (let i = 0; i < allPositions.length; i++) {
        const position = allPositions[i];
        const positionId = position.publicKey.toString().slice(0, 8);
        const claimableFeesA = position.feeOwedA || 0;
        const claimableFeesB = position.feeOwedB || 0;

        try {
          console.log(chalk.blue(`\n[${i + 1}/${allPositions.length}] Processing position ${positionId}...`));
          if (claimableFeesA > 0 || claimableFeesB > 0) {
            console.log(chalk.gray(`   Claimable fees: ${claimableFeesA > 0 ? claimableFeesA + ' (A) ' : ''}${claimableFeesB > 0 ? claimableFeesB + ' (B)' : ''}`));
          }

          if (!position.positionNftAccount) {
            console.log(chalk.red(`   ❌ No NFT account found for position ${positionId}`));
            continue;
          }

          // Add delay before checking position state to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 300));
          
          // Check if position has liquidity to determine the approach
          const positionState = await this.meteoraClient.getPositionState(position.publicKey);
          const hasLiquidity = positionState && (
            !positionState.unlockedLiquidity.isZero() ||
            !positionState.vestedLiquidity.isZero() ||
            !positionState.permanentLockedLiquidity.isZero()
          );

          // Step 1: Claim fees if there are any
          if (claimableFeesA > 0 || claimableFeesB > 0) {
            console.log(chalk.green(`   💰 Claiming fees...`));
            
            const claimSignature = await this.meteoraClient.claimFees(
              this.wallet,
              position.account.pool,
              position.publicKey,
              position.positionNftAccount!
            );

            allSignatures.push(claimSignature);
            totalFeesA += claimableFeesA;
            totalFeesB += claimableFeesB;

            console.log(chalk.green(`   ✅ Fees claimed! Signature: ${claimSignature}`));
            
            // Add delay after fee claiming
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          // Step 2: Close position (with or without liquidity removal)
          let closeSignature: string;
          let tokenMints: string[] = [];

          if (hasLiquidity) {
            console.log(chalk.blue(`   🔄 Removing liquidity and closing position...`));
            
            // Get pool info to know which tokens we'll receive
            const poolInfo = await this.meteoraClient.getPoolInfo(position.account.pool);
            tokenMints = poolInfo ? [
              poolInfo.tokenAMint.toString(),
              poolInfo.tokenBMint.toString()
            ] : [];
            
            closeSignature = await this.meteoraClient.removeAllLiquidityAndClosePosition(
              this.wallet,
              position.account.pool,
              position.publicKey,
              position.positionNftAccount!
            );

            console.log(chalk.green(`   ✅ Position closed with liquidity removed! Signature: ${closeSignature}`));
          } else {
            console.log(chalk.blue(`   🔄 Closing position (no liquidity)...`));
            
            closeSignature = await this.meteoraClient.closePosition(
              this.wallet,
              position.account.pool,
              position.publicKey,
              position.positionNftAccount!
            );

            console.log(chalk.green(`   ✅ Position closed! Signature: ${closeSignature}`));
          }

          allSignatures.push(closeSignature);

          // Add delay after position closing
          await new Promise(resolve => setTimeout(resolve, 500));

          // Step 3: Swap tokens to SOL if requested
          if (swapToSOL && tokenMints.length > 0) {
            console.log(chalk.blue(`   🔄 Swapping received tokens to SOL...`));
            
            // Wait for the close transaction to settle before swapping
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const swapResults = await this.meteoraClient.swapTokensToSOL(
              this.wallet,
              tokenMints,
              slippageBps
            );
            
            for (const swapResult of swapResults) {
              if (swapResult.success) {
                allSignatures.push(swapResult.signature);
                console.log(chalk.green(`   ✅ Token swapped to SOL! Signature: ${swapResult.signature}`));
              } else {
                console.log(chalk.yellow(`   ⚠️ Token swap failed: ${swapResult.error}`));
              }
            }
          }

          successfulOperations++;

          if (i < allPositions.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }

        } catch (positionError) {
          console.log(chalk.red(`   ❌ Failed to process position: ${positionError instanceof Error ? positionError.message : 'Unknown error'}`));
        }
      }

      console.log(chalk.blue('\n📈 Summary:'));
      console.log(chalk.gray(`   Positions processed: ${allPositions.length}`));
      console.log(chalk.gray(`   Successful: ${successfulOperations} | Failed: ${allPositions.length - successfulOperations}`));

      if (successfulOperations > 0) {
        return {
          success: true,
          signature: allSignatures[allSignatures.length - 1], // Return the last signature
          feesA: totalFeesA,
          feesB: totalFeesB
        };
      } else {
        return {
          success: false,
          error: 'No positions were successfully processed'
        };
      }

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  async closeAllPositionsOptimized(swapToSOL: boolean = false, slippageBps: number = 10, minValueLamports: number = 150000): Promise<ClaimResult> {
    try {
      console.log(chalk.blue('🔍 Processing positions...'));

      let totalFeesA = 0;
      let totalFeesB = 0;
      let successfulOperations = 0;
      let allSignatures: string[] = [];
      let positionCount = 0;

      // Get positions using the SDK method that streams results
      const userPositions = await this.meteoraClient.getUserPositions(this.wallet.publicKey);

      for (let i = 0; i < userPositions.length; i++) {
        const position = userPositions[i];
        positionCount++;
        const positionId = position.publicKey.toString().slice(0, 8);
        const claimableFeesA = position.feeOwedA || 0;
        const claimableFeesB = position.feeOwedB || 0;

        try {
          console.log(chalk.blue(`\n[${i + 1}] Processing position ${positionId}...`));
          if (claimableFeesA > 0 || claimableFeesB > 0) {
            console.log(chalk.gray(`   Claimable fees: ${claimableFeesA > 0 ? claimableFeesA + ' (A) ' : ''}${claimableFeesB > 0 ? claimableFeesB + ' (B)' : ''}`));
          }

          if (!position.positionNftAccount) {
            console.log(chalk.red(`   ❌ No NFT account found for position ${positionId}`));
            continue;
          }

          // Add delay before checking position state to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 300));
          
          // Check if position has liquidity to determine the approach
          const positionState = await this.meteoraClient.getPositionState(position.publicKey);
          const hasLiquidity = positionState && (
            !positionState.unlockedLiquidity.isZero() ||
            !positionState.vestedLiquidity.isZero() ||
            !positionState.permanentLockedLiquidity.isZero()
          );

          // Step 1: Claim fees if there are any
          if (claimableFeesA > 0 || claimableFeesB > 0) {
            console.log(chalk.green(`   💰 Claiming fees...`));
            
            const claimSignature = await this.meteoraClient.claimFees(
              this.wallet,
              position.account.pool,
              position.publicKey,
              position.positionNftAccount!
            );

            allSignatures.push(claimSignature);
            totalFeesA += claimableFeesA;
            totalFeesB += claimableFeesB;

            console.log(chalk.green(`   ✅ Fees claimed! Signature: ${claimSignature}`));
            
            // Add delay after fee claiming
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          // Step 2: Close position (with or without liquidity removal)
          let closeSignature: string;
          let tokenMints: string[] = [];

          if (hasLiquidity) {
            console.log(chalk.blue(`   🔄 Removing liquidity and closing position...`));
            
            // Get pool info to know which tokens we'll receive
            const poolInfo = await this.meteoraClient.getPoolInfo(position.account.pool);
            tokenMints = poolInfo ? [
              poolInfo.tokenAMint.toString(),
              poolInfo.tokenBMint.toString()
            ] : [];
            
            closeSignature = await this.meteoraClient.removeAllLiquidityAndClosePosition(
              this.wallet,
              position.account.pool,
              position.publicKey,
              position.positionNftAccount!
            );

            console.log(chalk.green(`   ✅ Position closed with liquidity removed! Signature: ${closeSignature}`));
          } else {
            console.log(chalk.blue(`   🔄 Closing position (no liquidity)...`));
            
            closeSignature = await this.meteoraClient.closePosition(
              this.wallet,
              position.account.pool,
              position.publicKey,
              position.positionNftAccount!
            );

            console.log(chalk.green(`   ✅ Position closed! Signature: ${closeSignature}`));
          }

          allSignatures.push(closeSignature);

          // Add delay after position closing
          await new Promise(resolve => setTimeout(resolve, 500));

          // Step 3: Swap tokens to SOL if requested
          if (swapToSOL && tokenMints.length > 0) {
            console.log(chalk.blue(`   🔄 Swapping received tokens to SOL...`));
            
            // Wait for the close transaction to settle before swapping
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const swapResults = await this.meteoraClient.swapTokensToSOL(
              this.wallet,
              tokenMints,
              slippageBps
            );
            
            for (const swapResult of swapResults) {
              if (swapResult.success) {
                allSignatures.push(swapResult.signature);
                console.log(chalk.green(`   ✅ Token swapped to SOL! Signature: ${swapResult.signature}`));
              } else {
                console.log(chalk.yellow(`   ⚠️ Token swap failed: ${swapResult.error}`));
              }
            }
          }

          successfulOperations++;

          if (i < userPositions.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }

        } catch (positionError) {
          console.log(chalk.red(`   ❌ Failed to process position: ${positionError instanceof Error ? positionError.message : 'Unknown error'}`));
        }
      }

      console.log(chalk.blue('\n📈 Summary:'));
      console.log(chalk.gray(`   Positions processed: ${positionCount}`));
      console.log(chalk.gray(`   Successful: ${successfulOperations} | Failed: ${positionCount - successfulOperations}`));

      if (successfulOperations > 0) {
        return {
          success: true,
          signature: allSignatures[allSignatures.length - 1], // Return the last signature
          feesA: totalFeesA,
          feesB: totalFeesB
        };
      } else {
        return {
          success: false,
          error: 'No positions were successfully processed'
        };
      }

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }
}

// CLI Commands
program
  .name('meteora-fee-claimer')
  .description('CLI tool to claim fees from Meteora DAMM V2 positions')
  .version('1.0.0');

// Default action - run interactive menu
program
  .action(async () => {
    try {
      const claimer = new MeteoraFeeClaimer();
      await claimer.runInteractiveMenu();
    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

program
  .command('summary')
  .description('Show summary of all positions and claimable fees')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (options: any) => {
    const spinner = ora('Fetching positions summary...').start();
    
    try {
      const claimer = new MeteoraFeeClaimer();
      
      spinner.text = 'Getting wallet info...';
      await claimer.getWalletInfo();
      
      const positions = await claimer.getUserPositions();
      
      spinner.succeed(`Found ${positions.length} position(s)`);
      
      if (positions.length === 0) {
        console.log(chalk.yellow('No positions found.'));
        return;
      }
      
      // Calculate totals
      let totalFeesA = 0;
      let totalFeesB = 0;
      let positionsWithFees = 0;
      
      const positionsByPool = new Map<string, any[]>();
      
      for (const position of positions) {
        const poolAddress = position.account.pool.toString();
        if (!positionsByPool.has(poolAddress)) {
          positionsByPool.set(poolAddress, []);
        }
        positionsByPool.get(poolAddress)!.push(position);
        
        const feesA = position.feeOwedA || 0;
        const feesB = position.feeOwedB || 0;
        
        totalFeesA += feesA;
        totalFeesB += feesB;
        
        if (feesA > 0 || feesB > 0) {
          positionsWithFees++;
        }
      }
      
      console.log(chalk.blue('\n📊 Positions Summary:'));
      console.log('='.repeat(80));
      console.log(chalk.gray(`Total Positions: ${positions.length}`));
      console.log(chalk.gray(`Positions with Fees: ${positionsWithFees}`));
      console.log(chalk.gray(`Unique Pools: ${positionsByPool.size}`));
      console.log();
      
      if (totalFeesA > 0 || totalFeesB > 0) {
        console.log(chalk.green('💰 Total Claimable Fees:'));
        if (totalFeesA > 0) {
          console.log(chalk.gray(`   Token A fees: ${totalFeesA} lamports`));
        }
        if (totalFeesB > 0) {
          console.log(chalk.gray(`   Token B fees: ${totalFeesB} lamports (~${(totalFeesB / 1e9).toFixed(6)} SOL)`));
        }
        console.log();
        console.log(chalk.blue('💡 Run "npm run claim-all" to claim all available fees'));
      } else {
        console.log(chalk.yellow('No claimable fees found.'));
      }
      
      if (options.verbose) {
        console.log(chalk.blue('\n📋 Detailed Breakdown by Pool:'));
        console.log('='.repeat(80));
        
        for (const [poolAddress, poolPositions] of positionsByPool) {
          const poolFeesA = poolPositions.reduce((sum, p) => sum + (p.feeOwedA || 0), 0);
          const poolFeesB = poolPositions.reduce((sum, p) => sum + (p.feeOwedB || 0), 0);
          
          console.log(chalk.blue(`\nPool: ${poolAddress.slice(0, 8)}...${poolAddress.slice(-8)}`));
          console.log(chalk.gray(`   Positions: ${poolPositions.length}`));
          if (poolFeesA > 0 || poolFeesB > 0) {
            console.log(chalk.green('   💰 Claimable fees:'));
            if (poolFeesA > 0) console.log(chalk.gray(`      Token A: ${poolFeesA}`));
            if (poolFeesB > 0) console.log(chalk.gray(`      Token B: ${poolFeesB}`));
          } else {
            console.log(chalk.gray('   No claimable fees'));
          }
        }
      }
      
    } catch (error) {
      spinner.fail('Failed to fetch positions summary');
      console.log(chalk.red(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

program
  .command('claim')
  .description('Claim fees from a specific pool')
  .argument('<pool-address>', 'The pool address to claim fees from')
  .option('--swap', 'Swap claimed tokens to SOL using Jupiter')
  .option('--slippage <bps>', 'Slippage tolerance in basis points (default: 10)', '10')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (poolAddress: string, options: any) => {
    const spinner = ora('Initializing fee claimer...').start();

    try {
      const claimer = new MeteoraFeeClaimer();

      spinner.text = 'Getting wallet info...';
      await claimer.getWalletInfo();

      spinner.text = 'Fetching pool information...';
      const poolInfo = await claimer.getPoolInfo(poolAddress);

      spinner.succeed('Pool found!');
      console.log(chalk.blue('🏊 Pool Info:'));
      console.log(chalk.gray(`   Address: ${poolAddress}`));
      console.log(chalk.gray(`   Token A: ${poolInfo.tokenAMint.toString()}`));
      console.log(chalk.gray(`   Token B: ${poolInfo.tokenBMint.toString()}`));
      console.log();

      const swapToSOL = !!options.swap;
      const slippageBps = parseInt(options.slippage);

      if (swapToSOL) {
        spinner.start('Claiming fees and swapping to SOL...');
        console.log(chalk.blue(`🔧 Swap enabled with ${slippageBps} BPS slippage tolerance`));
      } else {
        spinner.start('Claiming fees...');
      }

      const result = await claimer.claimFees(poolAddress, swapToSOL, slippageBps);

      if (result.success) {
        if (swapToSOL) {
          spinner.succeed('Fees claimed and swapped successfully!');
          console.log(chalk.green('🎉 Success! Fees claimed and tokens swapped to SOL!'));
        } else {
          spinner.succeed('Fees claimed successfully!');
          console.log(chalk.green('🎉 Success!'));
        }
        console.log(chalk.gray(`   Transaction: ${result.signature}`));
        if (result.feesA && result.feesA > 0) {
          console.log(chalk.gray(`   Fees A claimed: ${result.feesA}`));
        }
        if (result.feesB && result.feesB > 0) {
          console.log(chalk.gray(`   Fees B claimed: ${result.feesB}`));
        }
      } else {
        spinner.fail('Failed to claim fees');
        console.log(chalk.red(`❌ Error: ${result.error}`));
        process.exit(1);
      }

    } catch (error) {
      spinner.fail('Failed to initialize');
      console.log(chalk.red(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

program
  .command('positions')
  .description('List all your positions')
  .option('-p, --pool <address>', 'Filter by specific pool address')
  .action(async (options: any) => {
    const spinner = ora('Fetching positions...').start();
    
    try {
      const claimer = new MeteoraFeeClaimer();
      
      const positions = await claimer.getUserPositions(options.pool);
      
      spinner.succeed(`Found ${positions.length} position(s)`);
      
      if (positions.length === 0) {
        console.log(chalk.yellow('No positions found.'));
        return;
      }
      
      console.log(chalk.blue('\n📊 Your Positions:'));
      console.log('='.repeat(80));
      
      for (let i = 0; i < positions.length; i++) {
        const position = positions[i];
        console.log(chalk.green(`\n#${i + 1} Position: ${position.publicKey.toString()}`));
        if (position.feeOwedA > 0 || position.feeOwedB > 0) {
          console.log(chalk.gray(`   Claimable fees: ${position.feeOwedA > 0 ? position.feeOwedA + ' (A) ' : ''}${position.feeOwedB > 0 ? position.feeOwedB + ' (B)' : ''}`));
        }
        
        if (position.feeOwedA > 0 || position.feeOwedB > 0) {
          console.log(chalk.green('   💰 Has claimable fees!'));
        }
      }
      
    } catch (error) {
      spinner.fail('Failed to fetch positions');
      console.log(chalk.red(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

program
  .command('claim-all')
  .description('Claim fees from all positions with available fees')
  .option('--swap', 'Swap claimed tokens to SOL using Jupiter')
  .option('--slippage <bps>', 'Slippage tolerance in basis points (default: 10)', '10')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (options: any) => {
    const spinner = ora('Initializing fee claimer...').start();

    try {
      const claimer = new MeteoraFeeClaimer();

      spinner.text = 'Getting wallet info...';
      await claimer.getWalletInfo();

      const swapToSOL = !!options.swap;
      const slippageBps = parseInt(options.slippage);

      if (swapToSOL) {
        spinner.text = 'Scanning all positions for claimable fees and preparing to swap...';
        console.log(chalk.blue(`🔧 Swap enabled with ${slippageBps} BPS slippage tolerance`));
      } else {
        spinner.text = 'Scanning all positions for claimable fees...';
      }
      spinner.stop();

      const result = await claimer.claimAllFees(swapToSOL, slippageBps);

      if (result.success) {
        if (swapToSOL) {
          console.log(chalk.green('\n🎉 All available fees claimed and swapped successfully!'));
        } else {
          console.log(chalk.green('\n🎉 All available fees claimed successfully!'));
        }
        console.log(chalk.gray(`   Final Transaction: ${result.signature}`));
        if (result.feesA && result.feesA > 0) {
          console.log(chalk.gray(`   Total Fees A claimed: ${result.feesA}`));
        }
        if (result.feesB && result.feesB > 0) {
          console.log(chalk.gray(`   Total Fees B claimed: ${result.feesB}`));
        }
      } else {
        console.log(chalk.red(`❌ Error: ${result.error}`));
        process.exit(1);
      }

    } catch (error) {
      spinner.fail('Failed to claim fees');
      console.log(chalk.red(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

program
  .command('close-all-fast')
  .description('Close ALL positions (optimized for large position counts)')
  .option('--swap', 'Swap all received tokens to SOL using Jupiter')
  .option('--slippage <bps>', 'Slippage tolerance in basis points (default: 10)', '10')
  .option('--min-value <lamports>', 'Minimum token value in lamports to swap (default: 150000 = ~$0.15)', '150000')
  .option('--confirm', 'Skip confirmation prompt (dangerous!)')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (options: any) => {
    const spinner = ora('Initializing fast position closer...').start();

    try {
      const claimer = new MeteoraFeeClaimer();

      spinner.text = 'Getting wallet info...';
      await claimer.getWalletInfo();
      spinner.stop();

      const swapToSOL = !!options.swap;
      const slippageBps = parseInt(options.slippage);

      // Show warning
      console.log(chalk.red('⚠️  WARNING: This will close ALL your positions!'));
      console.log(chalk.gray('   • All fees will be claimed'));
      console.log(chalk.gray('   • All liquidity will be removed'));
      console.log(chalk.gray('   • All positions will be closed'));
      
      if (swapToSOL) {
        console.log(chalk.blue(`🔧 Swap to SOL: Enabled (${slippageBps} BPS slippage)`));
        console.log(chalk.gray('   • All received tokens will be swapped to SOL'));
      }
      
      console.log();

      if (!options.confirm) {
        const { proceed } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'proceed',
            message: `Are you sure you want to close ALL positions? (Position count will be determined during processing)`,
            default: false
          }
        ]);

        if (!proceed) {
          console.log(chalk.yellow('Operation cancelled.'));
          return;
        }
      }

      console.log(chalk.blue('🚀 Processing positions...'));
      const minValueLamports = parseInt(options.minValue);

      const result = await claimer.closeAllPositionsOptimized(swapToSOL, slippageBps, minValueLamports);

      if (result.success) {
        if (swapToSOL) {
          console.log(chalk.green('\n🎉 All positions closed and tokens swapped successfully!'));
        } else {
          console.log(chalk.green('\n🎉 All positions closed successfully!'));
        }
        console.log(chalk.gray(`   Final Transaction: ${result.signature}`));
        if (result.feesA && result.feesA > 0) {
          console.log(chalk.gray(`   Total Fees A claimed: ${result.feesA}`));
        }
        if (result.feesB && result.feesB > 0) {
          console.log(chalk.gray(`   Total Fees B claimed: ${result.feesB}`));
        }
      } else {
        console.log(chalk.red(`❌ Error: ${result.error}`));
        process.exit(1);
      }

    } catch (error) {
      spinner.fail('Failed to close positions');
      console.log(chalk.red(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

program
  .command('close-all')
  .description('Close ALL positions (claim fees, remove liquidity, and close)')
  .option('--swap', 'Swap all received tokens to SOL using Jupiter')
  .option('--slippage <bps>', 'Slippage tolerance in basis points (default: 10)', '10')
  .option('--confirm', 'Skip confirmation prompt (dangerous!)')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (options: any) => {
    const spinner = ora('Initializing position closer...').start();

    try {
      const claimer = new MeteoraFeeClaimer();

      spinner.text = 'Getting wallet info...';
      await claimer.getWalletInfo();

      // Get position count for confirmation
      const positions = await claimer.getUserPositions();
      const positionCount = positions.length;

      spinner.stop();

      if (positionCount === 0) {
        console.log(chalk.yellow('No positions found.'));
        return;
      }

      const swapToSOL = !!options.swap;
      const slippageBps = parseInt(options.slippage);

      // Show warning and ask for confirmation
      console.log(chalk.red('⚠️  WARNING: This will close ALL your positions!'));
      console.log(chalk.yellow(`📊 Found ${positionCount} position(s) that will be processed`));
      console.log(chalk.gray('   • All fees will be claimed'));
      console.log(chalk.gray('   • All liquidity will be removed'));
      console.log(chalk.gray('   • All positions will be closed'));
      
      if (swapToSOL) {
        console.log(chalk.blue(`🔧 Swap to SOL: Enabled (${slippageBps} BPS slippage)`));
        console.log(chalk.gray('   • All received tokens will be swapped to SOL'));
      }
      
      console.log();

      if (!options.confirm) {
        const { proceed } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'proceed',
            message: `Are you sure you want to close ALL ${positionCount} positions?`,
            default: false
          }
        ]);

        if (!proceed) {
          console.log(chalk.yellow('Operation cancelled.'));
          return;
        }
      }

      console.log(chalk.blue('🚀 Processing positions...'));
      const result = await claimer.closeAllPositions(swapToSOL, slippageBps);

      if (result.success) {
        if (swapToSOL) {
          console.log(chalk.green('\n🎉 All positions closed and tokens swapped successfully!'));
        } else {
          console.log(chalk.green('\n🎉 All positions closed successfully!'));
        }
        console.log(chalk.gray(`   Final Transaction: ${result.signature}`));
        if (result.feesA && result.feesA > 0) {
          console.log(chalk.gray(`   Total Fees A claimed: ${result.feesA}`));
        }
        if (result.feesB && result.feesB > 0) {
          console.log(chalk.gray(`   Total Fees B claimed: ${result.feesB}`));
        }
      } else {
        console.log(chalk.red(`❌ Error: ${result.error}`));
        process.exit(1);
      }

    } catch (error) {
      spinner.fail('Failed to close positions');
      console.log(chalk.red(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

program
  .command('close')
  .description('Close positions in a pool')
  .argument('<pool-address>', 'The pool address to close positions from')
  .option('--mode <mode>', 'Closing mode: claim-and-close (default), remove-liquidity, close-only', 'claim-and-close')
  .option('--swap', 'Swap received tokens to SOL using Jupiter after closing position')
  .option('--slippage <bps>', 'Slippage tolerance in basis points (default: 10)', '10')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (poolAddress: string, options: any) => {
    const spinner = ora('Initializing position closer...').start();

    try {
      const claimer = new MeteoraFeeClaimer();

      spinner.text = 'Getting wallet info...';
      await claimer.getWalletInfo();

      spinner.text = 'Fetching pool information...';
      const poolInfo = await claimer.getPoolInfo(poolAddress);

      spinner.succeed('Pool found!');
      console.log(chalk.blue('🏊 Pool Info:'));
      console.log(chalk.gray(`   Address: ${poolAddress}`));
      console.log(chalk.gray(`   Token A: ${poolInfo.tokenAMint.toString()}`));
      console.log(chalk.gray(`   Token B: ${poolInfo.tokenBMint.toString()}`));
      console.log();

      // Validate mode
      const validModes = ['claim-and-close', 'remove-liquidity', 'close-only'];
      if (!validModes.includes(options.mode)) {
        spinner.fail('Invalid mode');
        console.log(chalk.red(`❌ Invalid mode: ${options.mode}`));
        console.log(chalk.yellow(`Valid modes: ${validModes.join(', ')}`));
        process.exit(1);
      }

      const swapToSOL = !!options.swap;
      const slippageBps = parseInt(options.slippage);

      console.log(chalk.blue(`🔧 Mode: ${options.mode}`));
      
      if (swapToSOL) {
        console.log(chalk.blue(`🔧 Swap to SOL: Enabled (${slippageBps} BPS slippage)`));
      }
      console.log();

      spinner.start('Processing positions...');
      const result = await claimer.closePosition(poolAddress, options.mode, swapToSOL, slippageBps);

      if (result.success) {
        spinner.succeed('Positions processed successfully!');
        console.log(chalk.green('🎉 Success!'));
        console.log(chalk.gray(`   Final Transaction: ${result.signature}`));
        if (result.feesA && result.feesA > 0) {
          console.log(chalk.gray(`   Fees A claimed: ${result.feesA}`));
        }
        if (result.feesB && result.feesB > 0) {
          console.log(chalk.gray(`   Fees B claimed: ${result.feesB}`));
        }
      } else {
        spinner.fail('Failed to process positions');
        console.log(chalk.red(`❌ Error: ${result.error}`));
        process.exit(1);
      }

    } catch (error) {
      spinner.fail('Failed to process positions');
      console.log(chalk.red(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

program
  .command('info')
  .description('Show wallet and connection info')
  .action(async () => {
    try {
      const claimer = new MeteoraFeeClaimer();
      await claimer.getWalletInfo();

      const connection = new Connection(process.env.RPC_URL!, 'confirmed');
      const version = await connection.getVersion();
      console.log(chalk.blue('🌐 Connection Info:'));
      console.log(chalk.gray(`   RPC: ${process.env.RPC_URL}`));
      console.log(chalk.gray(`   Network: ${process.env.NETWORK || 'mainnet-beta'}`));
      console.log(chalk.gray(`   Solana Version: ${version['solana-core']}`));

    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();
