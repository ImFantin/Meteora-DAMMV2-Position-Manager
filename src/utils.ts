import { PublicKey, Connection } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Validates if a string is a valid Solana public key
 */
export function isValidPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates if a string is a valid private key (base58 or array format)
 */
export function isValidPrivateKey(privateKey: string): boolean {
  try {
    // Try to parse as array format first (Solflare export format)
    if (privateKey.trim().startsWith('[') && privateKey.trim().endsWith(']')) {
      const keyArray = JSON.parse(privateKey.trim());
      if (Array.isArray(keyArray) && keyArray.length === 64) {
        // Validate all elements are numbers between 0-255
        return keyArray.every(num => typeof num === 'number' && num >= 0 && num <= 255);
      }
      return false;
    }

    // Try to parse as base58 format
    const decoded = bs58.decode(privateKey);
    return decoded.length === 64; // Solana private keys are 64 bytes
  } catch {
    return false;
  }
}

/**
 * Converts array format private key to base58
 */
export function arrayToBase58(keyArray: number[]): string {
  const uint8Array = new Uint8Array(keyArray);
  return bs58.encode(uint8Array);
}

/**
 * Normalizes private key to Uint8Array format (supports both base58 and array formats)
 */
export function normalizePrivateKey(privateKey: string): Uint8Array {
  try {
    // Check if it's array format (Solflare export)
    if (privateKey.trim().startsWith('[') && privateKey.trim().endsWith(']')) {
      const keyArray = JSON.parse(privateKey.trim());
      if (Array.isArray(keyArray) && keyArray.length === 64) {
        return new Uint8Array(keyArray);
      }
      throw new Error('Invalid array format');
    }

    // Assume it's base58 format
    return bs58.decode(privateKey);
  } catch (error) {
    throw new Error(`Failed to parse private key: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Formats a number with appropriate decimal places
 */
export function formatNumber(num: number, decimals: number = 6): string {
  if (num === 0) return '0';
  if (num < 0.000001) return num.toExponential(3);
  return num.toFixed(decimals).replace(/\.?0+$/, '');
}

/**
 * Formats token amount based on decimals
 */
export function formatTokenAmount(amount: number, decimals: number): string {
  const divisor = Math.pow(10, decimals);
  const formatted = amount / divisor;
  return formatNumber(formatted);
}

/**
 * Truncates a string (like addresses) for display
 */
export function truncateAddress(address: string, chars: number = 4): string {
  if (address.length <= chars * 2) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Sleep utility for delays
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Adaptive rate limiting based on operation type
 * Different operations have different RPC call patterns
 */
export function rateLimitDelay(operationType: 'light' | 'medium' | 'heavy' = 'medium'): Promise<void> {
  const delays = {
    light: 200,   // Simple queries (200ms = 5 req/sec)
    medium: 500,  // Standard operations (500ms = 2 req/sec) 
    heavy: 1000   // Complex operations like position processing (1000ms = 1 req/sec)
  };

  return sleep(delays[operationType]);
}

/**
 * Fetch current SOL price in USD from CoinGecko API with retry logic
 */
export async function fetchSOLPrice(): Promise<number> {
  const fallbackPrice = 200;

  try {
    return await retry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      try {
        const response = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
          {
            signal: controller.signal,
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'meteora-position-manager/1.0.0'
            }
          }
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.solana && typeof data.solana.usd === 'number' && data.solana.usd > 0) {
          return data.solana.usd;
        }

        throw new Error('Invalid response format or price data');
      } finally {
        clearTimeout(timeoutId);
      }
    }, 2, 1000); // 2 retries with 1 second delay
  } catch (error) {
    console.log(`⚠️  Warning: Could not fetch SOL price after retries (${error instanceof Error ? error.message : 'Unknown error'}), using fallback price of $${fallbackPrice}`);
    return fallbackPrice;
  }
}

/**
 * Retry utility for network operations
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delay: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error');

      if (attempt === maxAttempts) {
        throw lastError;
      }

      await sleep(delay * attempt); // Exponential backoff
    }
  }

  throw lastError!;
}

/**
 * Modern transaction confirmation utility
 * Uses the recommended blockhash-based confirmation method
 */
export async function confirmTransactionModern(
  connection: Connection,
  signature: string,
  blockhash?: string,
  commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'
): Promise<void> {
  if (blockhash) {
    // Use the provided blockhash
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    }, commitment);
  } else {
    // Get fresh blockhash
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    }, commitment);
  }
}

/**
 * Check RPC connection health and performance
 */
export async function checkConnectionHealth(connection: Connection): Promise<{
  healthy: boolean;
  latency: number;
  blockHeight: number;
  error?: string;
}> {
  const startTime = Date.now();

  try {
    const blockHeight = await connection.getBlockHeight();
    const latency = Date.now() - startTime;

    return {
      healthy: latency < 5000, // Consider healthy if response < 5 seconds
      latency,
      blockHeight
    };
  } catch (error) {
    return {
      healthy: false,
      latency: Date.now() - startTime,
      blockHeight: 0,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}