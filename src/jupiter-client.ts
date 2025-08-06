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
    this.baseUrl = 'https://quote-api.jup.ag/v6';
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 10
  ): Promise<JupiterQuote | null> {
    try {
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: slippageBps.toString(),
        onlyDirectRoutes: 'false',
        asLegacyTransaction: 'false'
      });

      const response = await axios.get(`${this.baseUrl}/quote?${params.toString()}`, {
        headers: {
          'Accept': 'application/json'
        },
        timeout: 10000 // 10 second timeout for quote requests
      });

      return response.data;
    } catch (error: any) {
      // Only log errors that aren't "no route found" to reduce noise
      if (error.response?.data?.error !== 'No routes found') {
        console.error('Error getting Jupiter quote:', error.response?.data || error.message || error);
      }
      return null;
    }
  }

  async swap(
    userKeypair: Keypair,
    quoteResponse: JupiterQuote,
    priorityLevel: 'none' | 'low' | 'medium' | 'high' | 'veryHigh' = 'low'
  ): Promise<SwapResult> {
    try {
      const swapData = {
        userPublicKey: userKeypair.publicKey.toString(),
        quoteResponse,
        prioritizationFeeLamports: this.getPriorityFee(priorityLevel),
        dynamicComputeUnitLimit: true,
        dynamicSlippage: {
          maxBps: 300 // 3% max slippage
        }
      };

      const response = await axios.post('https://quote-api.jup.ag/v6/swap', swapData, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 15000 // 15 second timeout for swap requests
      });

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

      // Wait for confirmation with proper blockhash
      const latestBlockhash = await this.connection.getLatestBlockhash();
      await this.connection.confirmTransaction({
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
      }, 'confirmed');

      return {
        success: true,
        signature,
        inputAmount: parseInt(quoteResponse.inAmount),
        outputAmount: parseInt(quoteResponse.outAmount)
      };

    } catch (error: any) {
      // Log the actual error details for debugging
      console.log(`Jupiter swap error details:`, {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });

      // Handle specific Jupiter API errors with cleaner messages
      if (error.response?.status === 422) {
        return {
          success: false,
          error: 'No swap route found!'
        };
      }

      if (error.response?.status === 400) {
        return {
          success: false,
          error: 'Invalid swap parameters'
        };
      }

      if (error.response?.status === 429) {
        return {
          success: false,
          error: 'Rate limited, please try again later'
        };
      }

      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        return {
          success: false,
          error: 'Request timed out, please try again'
        };
      }

      // For other errors, show a generic message
      return {
        success: false,
        error: 'Swap failed - please try again'
      };
    }
  }

  async getSwapInstructions(
    userKeypair: Keypair,
    quoteResponse: JupiterQuote,
    priorityLevel: 'none' | 'low' | 'medium' | 'high' | 'veryHigh' = 'low'
  ): Promise<any> {
    try {
      const swapData = {
        userPublicKey: userKeypair.publicKey.toString(),
        quoteResponse,
        prioritizationFeeLamports: this.getPriorityFee(priorityLevel),
        dynamicComputeUnitLimit: true
      };

      const response = await axios.post('https://quote-api.jup.ag/v6/swap-instructions', swapData, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 15000 // 15 second timeout for swap instruction requests
      });

      return response.data;

    } catch (error) {
      console.error('Error getting Jupiter swap instructions:', error);
      throw error;
    }
  }



  private getPriorityFee(level: string): number {
    switch (level) {
      case 'none': return 0;
      case 'low': return 100000; // 0.0001 SOL (~$0.019)
      case 'medium': return 5000000; // 0.005 SOL
      case 'high': return 10000000; // 0.01 SOL
      case 'veryHigh': return 20000000; // 0.02 SOL
      default: return 100000; // Default to low
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