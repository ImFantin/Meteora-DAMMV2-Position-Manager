import { PublicKey } from '@solana/web3.js';
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
 * Validates if a string is a valid base58 private key
 */
export function isValidPrivateKey(privateKey: string): boolean {
  try {
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