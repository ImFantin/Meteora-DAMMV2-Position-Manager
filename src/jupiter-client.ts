import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import axios from 'axios';

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: any;
  priceImpactPct: string;
  routePlan: any[];
}

export interface SwapResult {
  success: boolean;
  signature?: string;
  error?: string;
  inputAmount?: number;
  outputAmount?: number;
}

export class JupiterClient {
  private connection: Connection;
  private baseUrl: string;

  constructor(connection: Connection) {
    this.connection = connection;
    this.baseUrl = 'https://lite-api.jup.ag/swap/v1';
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 10
  ): Promise<JupiterQuote | null> {
    try {
      const config = {
        method: 'get',
        url: `${this.baseUrl}/quote`,
        params: {
          inputMint,
          outputMint,
          amount: amount.toString(),
          slippageBps,
        },
        headers: {
          'Accept': 'application/json'
        }
      };

      const response = await axios.request(config);
      return response.data;
    } catch (error) {
      console.error('Error getting Jupiter quote:', error);
      return null;
    }
  }

  async swap(
    userKeypair: Keypair,
    quoteResponse: JupiterQuote,
    priorityLevel: 'none' | 'low' | 'medium' | 'high' | 'veryHigh' = 'medium'
  ): Promise<SwapResult> {
    try {
      const swapData = {
        userPublicKey: userKeypair.publicKey.toString(),
        quoteResponse,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: this.getPriorityFee(priorityLevel),
            priorityLevel
          }
        },
        dynamicComputeUnitLimit: true
      };

      const config = {
        method: 'post',
        url: `${this.baseUrl}/swap`,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        data: swapData
      };

      const response = await axios.request(config);
      const { swapTransaction } = response.data;

      // Deserialize the transaction
      const transactionBuf = Buffer.from(swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(transactionBuf);

      // Sign the transaction
      transaction.sign([userKeypair]);

      // Send the transaction
      const signature = await this.connection.sendTransaction(transaction, {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });

      // Wait for confirmation
      await this.connection.confirmTransaction(signature, 'confirmed');

      return {
        success: true,
        signature,
        inputAmount: parseInt(quoteResponse.inAmount),
        outputAmount: parseInt(quoteResponse.outAmount)
      };

    } catch (error) {
      console.error('Error executing Jupiter swap:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown swap error'
      };
    }
  }

  async getSwapInstructions(
    userKeypair: Keypair,
    quoteResponse: JupiterQuote,
    priorityLevel: 'none' | 'low' | 'medium' | 'high' | 'veryHigh' = 'medium'
  ): Promise<any> {
    try {
      const swapData = {
        userPublicKey: userKeypair.publicKey.toString(),
        quoteResponse,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: this.getPriorityFee(priorityLevel),
            priorityLevel
          }
        },
        dynamicComputeUnitLimit: true
      };

      const config = {
        method: 'post',
        url: `${this.baseUrl}/swap-instructions`,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        data: swapData
      };

      const response = await axios.request(config);
      return response.data;

    } catch (error) {
      console.error('Error getting Jupiter swap instructions:', error);
      throw error;
    }
  }

  private getPriorityFee(level: string): number {
    switch (level) {
      case 'none': return 0;
      case 'low': return 1000000; // 0.001 SOL
      case 'medium': return 5000000; // 0.005 SOL
      case 'high': return 10000000; // 0.01 SOL
      case 'veryHigh': return 20000000; // 0.02 SOL
      default: return 5000000;
    }
  }

  // Helper method to check if a token should be swapped to SOL
  isSwappableToken(mint: string): boolean {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
    
    // Don't swap if it's already SOL/WSOL
    return mint !== SOL_MINT && mint !== WSOL_MINT;
  }

  // Get the SOL mint address
  getSOLMint(): string {
    return 'So11111111111111111111111111111111111111112';
  }

  // Check if token amount is worth swapping (minimum $0.15 USD)
  async isWorthSwapping(
    tokenMint: string,
    amount: number,
    minValueLamports: number = 150000
  ): Promise<boolean> {
    try {
      const SOL_MINT = this.getSOLMint();
      
      // If it's already SOL, no need to swap
      if (!this.isSwappableToken(tokenMint)) {
        return false;
      }

      // Get a quote to see how much SOL we'd get
      const quote = await this.getQuote(tokenMint, SOL_MINT, amount, 10);
      
      if (!quote) {
        console.log(`   ⚠️ Could not get quote for ${tokenMint.slice(0, 8)}...`);
        return false;
      }

      const outputLamports = parseInt(quote.outAmount);
      const worthSwapping = outputLamports >= minValueLamports;
      
      if (worthSwapping) {
        console.log(`   💰 Token value: ${outputLamports} lamports (~$${(outputLamports / 1000000).toFixed(3)}) - Worth swapping`);
      } else {
        console.log(`   ⏭️ Token value: ${outputLamports} lamports (~$${(outputLamports / 1000000).toFixed(3)}) - Below threshold, skipping`);
      }
      
      return worthSwapping;
    } catch (error) {
      console.log(`   ⚠️ Error checking token value: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false; // If we can't check, don't swap to be safe
    }
  }
}