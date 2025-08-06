#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import dotenv from 'dotenv';
import inquirer from 'inquirer';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { isValidPublicKey, isValidPrivateKey, normalizePrivateKey, retry, rateLimitDelay, fetchSOLPrice } from './utils.js';
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

interface WalletInfo {
  name: string;
  keypair: Keypair;
  address: string;
}

class MeteoraFeeClaimer {
  private connection: Connection;
  private wallet: Keypair;
  private meteoraClient: MeteoraClient;
  private availableWallets: WalletInfo[];
  private selectedWallet: WalletInfo;

  constructor() {
    // Initialize connection
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
      throw new Error('RPC_URL not found in environment variables');
    }
    this.connection = new Connection(rpcUrl, 'confirmed');

    // Load all available wallets
    this.availableWallets = this.loadWallets();
    
    if (this.availableWallets.length === 0) {
      throw new Error('No valid private keys found in environment variables');
    }

    // Set default wallet (first one)
    this.selectedWallet = this.availableWallets[0];
    this.wallet = this.selectedWallet.keypair;

    // Initialize Meteora client
    this.meteoraClient = new MeteoraClient(this.connection);
  }

  private loadWallets(): WalletInfo[] {
    const wallets: WalletInfo[] = [];
    
    // Check for PRIVATE_KEY and PRIVATE_KEY_2, PRIVATE_KEY_3, etc.
    for (let i = 1; i <= 10; i++) {
      const keyName = i === 1 ? 'PRIVATE_KEY' : `PRIVATE_KEY_${i}`;
      const privateKey = process.env[keyName];
      
      if (privateKey) {
        if (!isValidPrivateKey(privateKey)) {
          console.log(chalk.yellow(`⚠️  Warning: Invalid private key format for ${keyName}, skipping`));
          continue;
        }

        try {
          const secretKey = normalizePrivateKey(privateKey);
          const keypair = Keypair.fromSecretKey(secretKey);
          const address = keypair.publicKey.toString();
          
          wallets.push({
            name: i === 1 ? 'Wallet 1' : `Wallet ${i}`,
            keypair,
            address
          });
        } catch (error) {
          console.log(chalk.yellow(`⚠️  Warning: Failed to create wallet from ${keyName}: ${error instanceof Error ? error.message : 'Unknown error'}`));
        }
      }
    }

    return wallets;
  }

  async selectWallet(): Promise<void> {
    if (this.availableWallets.length === 1) {
      console.log(chalk.blue(`🔑 Using ${this.selectedWallet.name}: ${this.selectedWallet.address.slice(0, 8)}...`));
      return;
    }

    console.log(chalk.blue(`\n🔑 Found ${this.availableWallets.length} wallets in configuration`));
    
    const choices = this.availableWallets.map((wallet, index) => ({
      name: `${wallet.name} - ${wallet.address.slice(0, 8)}...${wallet.address.slice(-8)}`,
      value: index
    }));

    const walletChoice = await inquirer.prompt([
      {
        type: 'list',
        name: 'walletIndex',
        message: 'Select wallet to use:',
        choices
      }
    ]);

    this.selectedWallet = this.availableWallets[walletChoice.walletIndex];
    this.wallet = this.selectedWallet.keypair;
    
    console.log(chalk.green(`✅ Selected ${this.selectedWallet.name}: ${this.selectedWallet.address}`));
  }

  async getWalletInfo(): Promise<void> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    console.log(chalk.blue(`🔑 ${this.selectedWallet.name} Info:`));
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

  async claimAllFees(swapToSOL: boolean = false, slippageBps: number = 10, minFeeThreshold: number = 0, solPrice: number = 200): Promise<ClaimResult> {
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

      // Filter positions with claimable fees above threshold
      const positionsWithFees = allPositions.filter(position => {
        const claimableFeesA = position.feeOwedA || 0;
        const claimableFeesB = position.feeOwedB || 0;
        const totalFees = claimableFeesA + claimableFeesB;
        return totalFees >= minFeeThreshold;
      });

      if (positionsWithFees.length === 0) {
        const message = minFeeThreshold > 0 
          ? `No positions with fees ≥ $${((minFeeThreshold / 1e9) * solPrice).toFixed(2)} found`
          : 'No positions with claimable fees found';
        return {
          success: false,
          error: message
        };
      }

      if (minFeeThreshold > 0) {
        const skippedPositions = allPositions.length - positionsWithFees.length;
        const thresholdUSD = ((minFeeThreshold / 1e9) * solPrice).toFixed(2);
        console.log(chalk.green(`💰 Found ${positionsWithFees.length} position(s) with fees ≥ $${thresholdUSD}`));
        if (skippedPositions > 0) {
          console.log(chalk.gray(`   (${skippedPositions} position(s) skipped due to low fees)`));
        }
      } else {
        console.log(chalk.green(`💰 Found ${positionsWithFees.length} position(s) with claimable fees`));
      }
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

          // Add delay before processing each position to respect rate limits
          if (i > 0) {
            await rateLimitDelay();
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

          // Add a delay between transactions to avoid rate limiting
          if (i < positionsWithFees.length - 1) {
            await rateLimitDelay();
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
    
    // Select wallet if multiple are available
    await this.selectWallet();
    
    await this.getWalletInfo();
    
    while (true) {
      try {
        // Simplified main menu
        const mainChoices = [
          { name: '💰 Claim All Fees (Keep Original Tokens)', value: 'claim-all' },
          { name: '🔥 Close All Positions (Claim + Close + Optional Swap)', value: 'close-all' },
          { name: '📊 View Position Summary', value: 'summary' }
        ];

        // Add wallet switching option if multiple wallets are available
        if (this.availableWallets.length > 1) {
          mainChoices.push({ name: '🔄 Switch Wallet', value: 'switch-wallet' });
        }

        mainChoices.push({ name: '❌ Exit', value: 'exit' });

        const mainChoice = await inquirer.prompt([
          {
            type: 'list',
            name: 'action',
            message: `What would you like to do? (Current: ${this.selectedWallet.name})`,
            choices: mainChoices
          }
        ]);

        if (mainChoice.action === 'exit') {
          console.log(chalk.green('\n👋 Goodbye!'));
          break;
        }

        if (mainChoice.action === 'switch-wallet') {
          await this.selectWallet();
          await this.getWalletInfo();
          continue;
        }

        if (mainChoice.action === 'summary') {
          await this.showSummary();
          continue;
        }

        if (mainChoice.action === 'claim-all') {
          await this.handleClaimAll(false, 10); // Keep tokens, default slippage
          continue;
        }

        if (mainChoice.action === 'close-all') {
          // Ask if user wants to swap to SOL
          const swapChoice = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'swapToSOL',
              message: 'Swap all received tokens to SOL?',
              default: false
            }
          ]);

          let slippageBps = 10;
          if (swapChoice.swapToSOL) {
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

          // Ask user to choose filtering method
          console.log(chalk.blue('\n🔍 Position Filtering Options'));
          console.log(chalk.gray('Choose how to filter which positions to close:'));
          
          const filterChoice = await inquirer.prompt([
            {
              type: 'list',
              name: 'filterType',
              message: 'How would you like to filter positions?',
              choices: [
                { name: '🎯 Filter by Pool Fee Rate (close positions in pools ≤ X%)', value: 'fee' },
                { name: '💎 Filter by Deposit Amount (close positions ≤ $X USD)', value: 'deposit' },
                { name: '🚀 Close All Positions (no filtering)', value: 'none' },
                { name: '⬅️  Back to Main Menu', value: 'back' }
              ]
            }
          ]);
          
          if (filterChoice.filterType === 'back') {
            continue; // Go back to main menu
          }
          
          let maxFeeRate: number | null = null;
          let maxDeposit: number | null = null;
          
          if (filterChoice.filterType === 'fee') {
            // Fee rate filtering
            console.log(chalk.blue('\n🎯 Fee Rate Filtering'));
            console.log(chalk.gray('Meteora pools start at 50% fees and decay over time.'));
            console.log(chalk.gray('You can filter to only close positions in pools with lower fees.'));
            
            const feeRateChoice = await inquirer.prompt([
              {
                type: 'input',
                name: 'maxFeeRate',
                message: 'Close positions in pools with fees ≤ X% (20 for ≤20%, 15 for ≤15%, 10 for ≤10%):',
                default: '20',
                validate: (input) => {
                  const num = parseFloat(input);
                  if (isNaN(num) || num < 0 || num > 100) {
                    return 'Please enter a number between 0 and 100';
                  }
                  return true;
                }
              }
            ]);
            
            maxFeeRate = parseFloat(feeRateChoice.maxFeeRate);
            console.log(chalk.blue(`✅ Will close positions in pools with fees ≤ ${maxFeeRate}% (pools with higher fees will be skipped)`));
            
          } else if (filterChoice.filterType === 'deposit') {
            // Deposit amount filtering
            console.log(chalk.blue('\n💎 Deposit Amount Filtering'));
            console.log(chalk.gray('Filter positions based on their deposit value in USD.'));
            console.log(chalk.gray('This helps you target dust positions or specific size ranges.'));
            
            const depositFilterChoice = await inquirer.prompt([
              {
                type: 'input',
                name: 'maxDeposit',
                message: 'Close positions with deposits ≤ $X USD (1 for ≤$1, 5 for ≤$5, 10 for ≤$10):',
                default: '5',
                validate: (input) => {
                  const num = parseFloat(input);
                  if (isNaN(num) || num <= 0) {
                    return 'Please enter a number greater than 0';
                  }
                  return true;
                }
              }
            ]);
            
            const maxDepositUSD = parseFloat(depositFilterChoice.maxDeposit);
            
            // Convert USD to SOL using current SOL price
            const solPrice = await fetchSOLPrice();
            maxDeposit = maxDepositUSD / solPrice;
            console.log(chalk.gray(`   Converting $${maxDepositUSD} USD to ${maxDeposit.toFixed(6)} SOL (at $${solPrice.toFixed(2)}/SOL)`));
            console.log(chalk.blue(`✅ Will close positions with deposits ≤ $${maxDepositUSD} USD (~${maxDeposit.toFixed(6)} SOL)`));
            
          } else {
            // No filtering
            console.log(chalk.blue('✅ Will close ALL positions (no filtering)'));
          }

          await this.handleCloseAll(swapChoice.swapToSOL, slippageBps, maxFeeRate, maxDeposit);
          continue;
        }

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





  async handleClaimAll(swapToSOL: boolean, slippageBps: number): Promise<void> {
    // Ask for minimum fee threshold
    console.log(chalk.blue('\n💰 Minimum Fee Threshold'));
    console.log(chalk.gray('Set a minimum fee amount to avoid claiming tiny amounts.'));
    console.log(chalk.gray('Fees below this threshold will be skipped to save on transaction costs.'));
    
    // Fetch current SOL price
    console.log(chalk.gray('📊 Fetching current SOL price...'));
    const solPrice = await fetchSOLPrice();
    console.log(chalk.gray(`💲 Current SOL price: $${solPrice.toFixed(2)}`));
    
    const feeThresholdChoice = await inquirer.prompt([
      {
        type: 'input',
        name: 'minFeeThreshold',
        message: 'Minimum fee amount to claim (in USD, enter 0 for no limit, 0.10 for $0.10):',
        default: '0',
        validate: (input) => {
          const num = parseFloat(input);
          if (isNaN(num) || num < 0) {
            return 'Please enter a number 0 or greater';
          }
          return true;
        }
      }
    ]);
    
    const minFeeThresholdUSD = parseFloat(feeThresholdChoice.minFeeThreshold);
    const minFeeThresholdSOL = minFeeThresholdUSD / solPrice;
    const minFeeThreshold = Math.floor(minFeeThresholdSOL * 1e9); // Convert SOL to lamports
    
    if (minFeeThreshold > 0) {
      console.log(chalk.blue(`✅ Will only claim fees ≥ $${minFeeThresholdUSD} (~${minFeeThresholdSOL.toFixed(6)} SOL at $${solPrice.toFixed(2)}/SOL)`));
    } else {
      console.log(chalk.blue('✅ Will claim all available fees (no minimum threshold)'));
    }

    const confirmChoice = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: swapToSOL ? 
          'This will claim ALL qualifying fees from ALL positions and swap tokens to SOL. Continue?' :
          'This will claim ALL qualifying fees from ALL positions. Continue?',
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
      const result = await this.claimAllFees(swapToSOL, slippageBps, minFeeThreshold, solPrice);
      
      if (result.success) {
        console.log(chalk.green('\n🎉 All qualifying fees claimed successfully!'));
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

  async handleCloseAll(swapToSOL: boolean, slippageBps: number, maxFeeRate: number | null = null, maxDeposit: number | null = null): Promise<void> {
    // Get all positions
    const allPositions = await this.getUserPositions();

    if (allPositions.length === 0) {
      console.log(chalk.yellow('No positions found.'));
      return;
    }

    // Pre-filter positions by fee rate if filter is enabled
    let eligiblePositions = allPositions;
    if (maxFeeRate !== null) {
      console.log(chalk.blue(`🔍 Checking fee rates for ${allPositions.length} positions...`));
      eligiblePositions = [];
      
      for (let i = 0; i < allPositions.length; i++) {
        const position = allPositions[i];
        const positionId = position.publicKey.toString().slice(0, 8);
        
        try {
          const isEligible = await this.meteoraClient.isPoolEligibleForClosing(position.account.pool, maxFeeRate);
          if (isEligible) {
            eligiblePositions.push(position);
          } else {
            console.log(chalk.gray(`   ⏭️ ${positionId}: Pool fee rate too high, skipping`));
          }
        } catch (error) {
          console.log(chalk.gray(`   ⚠️ ${positionId}: Could not check fee rate, skipping`));
        }
        
        // Add delay to avoid rate limits
        if (i < allPositions.length - 1) {
          await rateLimitDelay();
        }
      }
      
      console.log(chalk.blue(`✅ Found ${eligiblePositions.length} positions eligible for closing (fee rate ≤ ${maxFeeRate}%)`));
    }

    // Further filter positions by deposit amount if filter is enabled
    if (maxDeposit !== null) {
      // Get current SOL price for USD conversion in display
      const solPrice = await fetchSOLPrice();
      const maxDepositUSD = maxDeposit * solPrice;
      
      console.log(chalk.blue(`💎 Filtering positions by deposit amount ≤ $${maxDepositUSD.toFixed(2)} USD (~${maxDeposit.toFixed(6)} SOL)...`));
      const beforeDepositFilter = eligiblePositions.length;
      
      eligiblePositions = eligiblePositions.filter(position => {
        const totalDeposit = (position.depositA || 0) + (position.depositB || 0);
        const positionId = position.publicKey.toString().slice(0, 8);
        const totalDepositUSD = totalDeposit * solPrice;
        
        if (totalDeposit <= maxDeposit) {
          return true;
        } else {
          console.log(chalk.gray(`   ⏭️ ${positionId}: Deposit $${totalDepositUSD.toFixed(2)} USD > $${maxDepositUSD.toFixed(2)} USD, skipping`));
          return false;
        }
      });
      
      console.log(chalk.blue(`✅ Found ${eligiblePositions.length} positions with deposits ≤ $${maxDepositUSD.toFixed(2)} USD (${beforeDepositFilter - eligiblePositions.length} filtered out)`));
    }

    const positionCount = eligiblePositions.length;
    
    if (positionCount === 0) {
      const filterMessage = maxFeeRate !== null && maxDeposit !== null 
        ? 'No positions meet both the fee rate and deposit criteria.'
        : maxFeeRate !== null 
        ? 'No positions meet the fee rate criteria.'
        : maxDeposit !== null
        ? 'No positions meet the deposit criteria.'
        : 'No positions found.';
      console.log(chalk.yellow(filterMessage));
      return;
    }

    console.log(chalk.red('⚠️  WARNING: This will close your positions!'));
    console.log(chalk.yellow(`📊 Found ${positionCount} position(s) that will be processed`));
    console.log(chalk.gray('   • All fees will be claimed'));
    console.log(chalk.gray('   • All liquidity will be removed'));
    console.log(chalk.gray('   • All positions will be closed'));
    
    if (maxFeeRate !== null) {
      console.log(chalk.blue(`🎯 Fee Rate Filter: Only pools with fee rate ≤ ${maxFeeRate}% (${positionCount}/${allPositions.length} positions)`));
    }
    
    if (swapToSOL) {
      console.log(chalk.blue(`🔧 Swap to SOL: Enabled (${slippageBps} BPS slippage)`));
      console.log(chalk.gray('   • All received tokens will be swapped to SOL'));
    }
    
    console.log();

    const confirmChoice = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Are you absolutely sure you want to close ${positionCount} position(s)?`,
        default: false
      }
    ]);

    if (!confirmChoice.confirm) {
      console.log(chalk.yellow('Operation cancelled.'));
      return;
    }

    console.log(chalk.blue('🚀 Processing positions...'));
    const result = await this.closeAllPositions(swapToSOL, slippageBps, maxFeeRate, null, eligiblePositions);

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
      
      if (positions.length === 0) {
        spinner.succeed('No positions found');
        console.log(chalk.yellow('No positions found.'));
        return;
      }

      spinner.text = 'Calculating fee values...';
      
      // Get current SOL price for fee USD calculations
      const solPrice = await fetchSOLPrice();
      
      // Calculate totals
      let totalFeesA = 0;
      let totalFeesB = 0;
      let totalDepositsA = 0;
      let totalDepositsB = 0;
      let positionsWithFees = 0;
      let positionsWithDeposits = 0;
      let totalFeesUSD = 0;
      let totalDepositsUSD = 0;


      
      const positionsByPool = new Map<string, any[]>();
      
      // Process each position
      for (const position of positions) {
        const poolAddress = position.account.pool.toString();
        
        if (!positionsByPool.has(poolAddress)) {
          positionsByPool.set(poolAddress, []);
        }
        positionsByPool.get(poolAddress)!.push(position);
        
        const feesA = position.feeOwedA || 0;
        const feesB = position.feeOwedB || 0;
        const depositsA = position.depositA || 0;
        const depositsB = position.depositB || 0;
        
        totalFeesA += feesA;
        totalFeesB += feesB;
        totalDepositsA += depositsA;
        totalDepositsB += depositsB;
        
        if (feesA > 0 || feesB > 0) {
          positionsWithFees++;
        }
        
        if (depositsA > 0 || depositsB > 0) {
          positionsWithDeposits++;
        }
      }

      // Calculate USD values
      totalFeesUSD = (totalFeesB / 1e9) * solPrice;
      totalDepositsUSD = (totalDepositsA + totalDepositsB) * solPrice;
      
      spinner.succeed(`Found ${positions.length} position(s)`);
      
      console.log(chalk.blue('\n📊 Positions Summary:'));
      console.log('='.repeat(60));
      console.log(chalk.gray(`Total Positions: ${positions.length}`));
      console.log(chalk.gray(`Positions with Fees: ${positionsWithFees}`));
      console.log(chalk.gray(`Positions with Deposits: ${positionsWithDeposits}`));
      console.log(chalk.gray(`Unique Pools: ${positionsByPool.size}`));
      console.log();
      
      // Display deposit information
      if (totalDepositsA > 0 || totalDepositsB > 0) {
        console.log(chalk.blue('💎 Total Deposits:'));
        const totalDepositSOL = totalDepositsA + totalDepositsB;
        console.log(chalk.gray(`   Total: ~${totalDepositSOL.toFixed(6)} SOL`));
        if (totalDepositsUSD > 0) {
          console.log(chalk.gray(`   Estimated USD Value: ~$${totalDepositsUSD.toFixed(2)}`));
        }
        console.log();
      }
      
      // Display fee information
      if (totalFeesA > 0 || totalFeesB > 0) {
        console.log(chalk.green('💰 Total Claimable Fees:'));
        if (totalFeesA > 0) {
          console.log(chalk.gray(`   Token A: ~${(totalFeesA / 1e9).toFixed(6)} SOL`));
        }
        if (totalFeesB > 0) {
          console.log(chalk.gray(`   Token B: ~${(totalFeesB / 1e9).toFixed(6)} SOL`));
        }
        if (totalFeesUSD > 0) {
          console.log(chalk.gray(`   Estimated USD Value: ~$${totalFeesUSD.toFixed(2)}`));
        }
      } else {
        console.log(chalk.yellow('No claimable fees found.'));
      }
      
      // Add Total Summary (Deposits + Fees)
      const totalDepositSOL = totalDepositsA + totalDepositsB;
      const totalFeeSOL = (totalFeesA + totalFeesB) / 1e9;
      const totalValueSOL = totalDepositSOL + totalFeeSOL;
      const totalValueUSD = totalDepositsUSD + totalFeesUSD;
      
      console.log();
      console.log(chalk.magenta('🏆 Total Portfolio Value (Deposits + Fees):'));
      console.log(chalk.gray(`   Deposits: ~${totalDepositSOL.toFixed(6)} SOL + Fees: ~${totalFeeSOL.toFixed(6)} SOL`));
      console.log(chalk.gray(`   Grand Total: ~${totalValueSOL.toFixed(6)} SOL`));
      if (totalValueUSD > 0) {
        console.log(chalk.gray(`   Estimated USD Value: ~$${totalValueUSD.toFixed(2)}`));
      }
      console.log();
      
    } catch (error) {
      spinner.fail('Failed to fetch positions summary');
      throw error;
    }
  }

  async closePosition(poolAddress: string, mode: 'claim-and-close' | 'remove-liquidity' | 'close-only' = 'claim-and-close', swapToSOL: boolean = false, slippageBps: number = 10, maxFeeRate: number | null = null): Promise<ClaimResult> {
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

          // Check pool fee rate if filter is enabled
          if (maxFeeRate !== null) {
            const isEligible = await this.meteoraClient.isPoolEligibleForClosing(poolPubkey, maxFeeRate);
            if (!isEligible) {
              console.log(chalk.yellow(`   ⏭️ Skipping - pool fee rate too high`));
              continue;
            }
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

  async closeAllPositions(swapToSOL: boolean = false, slippageBps: number = 10, maxFeeRate: number | null = null, maxDeposit: number | null = null, preFilteredPositions?: any[]): Promise<ClaimResult> {
    try {
      console.log(chalk.blue('🔍 Scanning all positions for closing...'));

      // Use pre-filtered positions if provided, otherwise get all positions
      const allPositions = preFilteredPositions || await this.getUserPositions();

      if (allPositions.length === 0) {
        return {
          success: false,
          error: 'No positions found'
        };
      }

      console.log(chalk.blue(`📊 Found ${allPositions.length} total position(s)`));
      
      // Apply deposit filtering if enabled
      let eligiblePositions = allPositions;
      if (maxDeposit !== null) {
        const solPrice = await fetchSOLPrice();
        const maxDepositSOL = maxDeposit / solPrice;
        console.log(chalk.blue(`💎 Filtering positions by deposit amount ≤ $${maxDeposit} USD (~${maxDepositSOL.toFixed(4)} SOL)`));
        
        eligiblePositions = allPositions.filter(position => {
          const totalDeposit = (position.depositA || 0) + (position.depositB || 0);
          const totalDepositUSD = totalDeposit * solPrice;
          
          if (totalDeposit <= maxDepositSOL) {
            return true;
          } else {
            const positionId = position.publicKey.toString().slice(0, 8);
            console.log(chalk.gray(`   ⏭️ ${positionId}: Deposit $${totalDepositUSD.toFixed(2)} USD > $${maxDeposit} USD, skipping`));
            return false;
          }
        });
        
        console.log(chalk.blue(`📊 After filtering: ${eligiblePositions.length} position(s) eligible for closing`));
      }

      if (eligiblePositions.length === 0) {
        return {
          success: false,
          error: maxDeposit !== null ? `No positions found with deposits ≤ $${maxDeposit} USD` : 'No eligible positions found'
        };
      }
      
      console.log(chalk.yellow('⚠️  This will close all eligible positions and remove liquidity!'));
      console.log();

      let totalFeesA = 0;
      let totalFeesB = 0;
      let successfulOperations = 0;
      let allSignatures: string[] = [];

      // Process each position
      for (let i = 0; i < eligiblePositions.length; i++) {
        const position = eligiblePositions[i];
        const positionId = position.publicKey.toString().slice(0, 8);
        const claimableFeesA = position.feeOwedA || 0;
        const claimableFeesB = position.feeOwedB || 0;

        try {
          console.log(chalk.blue(`\n[${i + 1}/${eligiblePositions.length}] Processing position ${positionId}...`));
          if (claimableFeesA > 0 || claimableFeesB > 0) {
            console.log(chalk.gray(`   Claimable fees: ${claimableFeesA > 0 ? claimableFeesA + ' (A) ' : ''}${claimableFeesB > 0 ? claimableFeesB + ' (B)' : ''}`));
          }

          if (!position.positionNftAccount) {
            console.log(chalk.red(`   ❌ No NFT account found for position ${positionId}`));
            continue;
          }

          // Fee rate filtering already done in pre-filtering step

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

  async closeAllPositionsOptimized(swapToSOL: boolean = false, slippageBps: number = 10, minValueLamports: number = 150000, maxDeposit: number | null = null): Promise<ClaimResult> {
    try {
      console.log(chalk.blue('🔍 Processing positions...'));

      let totalFeesA = 0;
      let totalFeesB = 0;
      let successfulOperations = 0;
      let allSignatures: string[] = [];

      // Get positions using the SDK method that streams results
      const userPositions = await this.meteoraClient.getUserPositions(this.wallet.publicKey);
      
      console.log(chalk.blue(`📊 Found ${userPositions.length} total position(s)`));

      // Apply deposit filtering if enabled
      let eligiblePositions = userPositions;
      if (maxDeposit !== null) {
        const solPrice = await fetchSOLPrice();
        const maxDepositSOL = maxDeposit / solPrice;
        console.log(chalk.blue(`💎 Filtering positions by deposit amount ≤ $${maxDeposit} USD (~${maxDepositSOL.toFixed(4)} SOL)`));
        
        eligiblePositions = userPositions.filter(position => {
          const totalDeposit = (position.depositA || 0) + (position.depositB || 0);
          const totalDepositUSD = totalDeposit * solPrice;
          
          if (totalDeposit <= maxDepositSOL) {
            return true;
          } else {
            const positionId = position.publicKey.toString().slice(0, 8);
            console.log(chalk.gray(`   ⏭️ ${positionId}: Deposit $${totalDepositUSD.toFixed(2)} USD > $${maxDeposit} USD, skipping`));
            return false;
          }
        });
        
        console.log(chalk.blue(`📊 After filtering: ${eligiblePositions.length} position(s) eligible for closing`));
      }

      if (eligiblePositions.length === 0) {
        return {
          success: false,
          error: maxDeposit !== null ? `No positions found with deposits ≤ $${maxDeposit} USD` : 'No positions found'
        };
      }

      for (let i = 0; i < eligiblePositions.length; i++) {
        const position = eligiblePositions[i];
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
      console.log(chalk.gray(`   Positions processed: ${eligiblePositions.length}`));
      console.log(chalk.gray(`   Successful: ${successfulOperations} | Failed: ${eligiblePositions.length - successfulOperations}`));

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
      let totalDepositsA = 0;
      let totalDepositsB = 0;
      let positionsWithFees = 0;
      let positionsWithDeposits = 0;
      
      const positionsByPool = new Map<string, any[]>();
      
      for (const position of positions) {
        const poolAddress = position.account.pool.toString();
        if (!positionsByPool.has(poolAddress)) {
          positionsByPool.set(poolAddress, []);
        }
        positionsByPool.get(poolAddress)!.push(position);
        
        const feesA = position.feeOwedA || 0;
        const feesB = position.feeOwedB || 0;
        const depositsA = position.depositA || 0;
        const depositsB = position.depositB || 0;
        
        totalFeesA += feesA;
        totalFeesB += feesB;
        totalDepositsA += depositsA;
        totalDepositsB += depositsB;
        
        if (feesA > 0 || feesB > 0) {
          positionsWithFees++;
        }
        
        if (depositsA > 0 || depositsB > 0) {
          positionsWithDeposits++;
        }
      }
      
      console.log(chalk.blue('\n📊 Positions Summary:'));
      console.log('='.repeat(80));
      console.log(chalk.gray(`Total Positions: ${positions.length}`));
      console.log(chalk.gray(`Positions with Fees: ${positionsWithFees}`));
      console.log(chalk.gray(`Positions with Deposits: ${positionsWithDeposits}`));
      console.log(chalk.gray(`Unique Pools: ${positionsByPool.size}`));
      console.log();
      
      // Display deposit information
      if (totalDepositsA > 0 || totalDepositsB > 0) {
        console.log(chalk.blue('💎 Total Deposits:'));
        const totalDepositSOL = totalDepositsA + totalDepositsB;
        console.log(chalk.gray(`   Total: ~${totalDepositSOL.toFixed(6)} SOL`));
        console.log();
      }
      
      if (totalFeesA > 0 || totalFeesB > 0) {
        console.log(chalk.green('💰 Total Claimable Fees:'));
        if (totalFeesA > 0) {
          console.log(chalk.gray(`   Token A: ~${(totalFeesA / 1e9).toFixed(6)} SOL`));
        }
        if (totalFeesB > 0) {
          console.log(chalk.gray(`   Token B: ~${(totalFeesB / 1e9).toFixed(6)} SOL`));
        }
        console.log();
        console.log(chalk.blue('💡 Run "npm run claim-all" to claim all available fees'));
      } else {
        console.log(chalk.yellow('No claimable fees found.'));
      }
      
      // Add Total Summary (Deposits + Fees)
      const totalDepositSOL = totalDepositsA + totalDepositsB;
      const totalFeeSOL = (totalFeesA + totalFeesB) / 1e9;
      const totalValueSOL = totalDepositSOL + totalFeeSOL;
      
      console.log();
      console.log(chalk.magenta('🏆 Total Portfolio Value (Deposits + Fees):'));
      console.log(chalk.gray(`   Deposits: ~${totalDepositSOL.toFixed(6)} SOL + Fees: ~${totalFeeSOL.toFixed(6)} SOL`));
      console.log(chalk.gray(`   Grand Total: ~${totalValueSOL.toFixed(6)} SOL`));
      
      // Get SOL price for USD calculation
      const solPrice = await fetchSOLPrice();
      const totalValueUSD = totalValueSOL * solPrice;
      if (totalValueUSD > 0) {
        console.log(chalk.gray(`   Estimated USD Value: ~$${totalValueUSD.toFixed(2)}`));
      }
      console.log();
      
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
  .option('--min-fee <usd>', 'Minimum fee amount to claim in USD (default: 0)', '0')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (options: any) => {
    const spinner = ora('Initializing fee claimer...').start();

    try {
      const claimer = new MeteoraFeeClaimer();

      spinner.text = 'Getting wallet info...';
      await claimer.getWalletInfo();

      const swapToSOL = !!options.swap;
      const slippageBps = parseInt(options.slippage);
      const minFeeThresholdUSD = parseFloat(options.minFee);
      
      // Fetch current SOL price
      spinner.text = 'Fetching current SOL price...';
      const solPrice = await fetchSOLPrice();
      console.log(chalk.gray(`💲 Current SOL price: $${solPrice.toFixed(2)}`));
      
      const minFeeThresholdSOL = minFeeThresholdUSD / solPrice;
      const minFeeThreshold = Math.floor(minFeeThresholdSOL * 1e9); // Convert SOL to lamports

      if (swapToSOL) {
        spinner.text = 'Scanning all positions for claimable fees and preparing to swap...';
        console.log(chalk.blue(`🔧 Swap enabled with ${slippageBps} BPS slippage tolerance`));
      } else {
        spinner.text = 'Scanning all positions for claimable fees...';
      }
      
      if (minFeeThreshold > 0) {
        console.log(chalk.blue(`💰 Minimum fee threshold: $${minFeeThresholdUSD} (~${minFeeThresholdSOL.toFixed(6)} SOL at $${solPrice.toFixed(2)}/SOL)`));
      }
      
      spinner.stop();

      const result = await claimer.claimAllFees(swapToSOL, slippageBps, minFeeThreshold, solPrice);

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
  .option('--max-deposit <usd>', 'Maximum deposit amount in USD to close (positions with higher deposits will be skipped)')
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
      const maxDeposit = options.maxDeposit ? parseFloat(options.maxDeposit) : null;

      // Show warning
      console.log(chalk.red('⚠️  WARNING: This will close positions!'));
      if (maxDeposit !== null) {
        console.log(chalk.blue(`💎 Deposit Filter: Enabled - closing positions ≤ $${maxDeposit} USD`));
        console.log(chalk.gray('   • Positions with higher deposits will be skipped'));
      } else {
        console.log(chalk.gray('   • ALL positions will be closed'));
      }
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

      const result = await claimer.closeAllPositionsOptimized(swapToSOL, slippageBps, minValueLamports, maxDeposit);

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
  .option('--max-deposit <usd>', 'Maximum deposit amount in USD to close (positions with higher deposits will be skipped)')
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
      const maxDeposit = options.maxDeposit ? parseFloat(options.maxDeposit) : null;

      // Show warning and ask for confirmation
      console.log(chalk.red('⚠️  WARNING: This will close positions!'));
      if (maxDeposit !== null) {
        console.log(chalk.blue(`💎 Deposit Filter: Enabled - closing positions ≤ $${maxDeposit} USD`));
        console.log(chalk.yellow(`📊 Found ${positionCount} position(s) total (will filter by deposit amount)`));
        console.log(chalk.gray('   • Positions with higher deposits will be skipped'));
      } else {
        console.log(chalk.yellow(`📊 Found ${positionCount} position(s) that will be processed`));
        console.log(chalk.gray('   • ALL positions will be closed'));
      }
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
      const result = await claimer.closeAllPositions(swapToSOL, slippageBps, null, maxDeposit);

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
