# Meteora Position Manager - Usage Guide

## Overview

The Meteora Position Manager is a command-line tool designed to efficiently manage your Meteora DAMM V2 positions with automated fee claiming, position closing, and token swapping capabilities.

## Key Features

### Multi-Wallet Support
- Manage multiple wallets from a single configuration
- Easy wallet switching during runtime
- Supports both Base58 and Solflare array private key formats

### Smart Fee Management
- Real-time USD thresholds using live SOL pricing from CoinGecko
- Automatic filtering to skip low-value fee claims
- Rate-limited processing to respect RPC limits

### Position Management
- Comprehensive position analytics and summaries
- Fee rate filtering for optimal closing strategies
- Automated position closing with optional token swapping

## Configuration

### Environment Setup

Create a `.env` file with your configuration:

```env
# Solana RPC URL (QuickNode recommended)
RPC_URL=https://your-endpoint.solana-mainnet.quiknode.pro/your-token/

# Primary wallet (Base58 format)
PRIVATE_KEY=your_base58_private_key_here

# Additional wallets (optional)
PRIVATE_KEY_2=your_second_wallet_here
PRIVATE_KEY_3=[1,2,3,4,5...]  # Solflare array format
```

### Private Key Formats

**Base58 Format (Most Common):**
```
PRIVATE_KEY=your_actual_64_character_base58_private_key_from_your_wallet
```

**Solflare Array Format:**
```
PRIVATE_KEY_2=[1,2,3,4,5,6,7,8,9,10,...64_numbers_total]
```

## Usage Modes

### Interactive Mode (Recommended)

Launch the interactive menu:
```bash
node dist/index.js
```

**Menu Options:**
- **💰 Claim All Fees** - Collect fees while keeping original tokens
- **🔥 Close All Positions** - Complete cleanup with optional SOL conversion
- **📊 View Position Summary** - Analyze your positions
- **🔄 Switch Wallet** - Change active wallet (if multiple configured)

### Command Line Interface

**Claim all fees with USD threshold:**
```bash
node dist/index.js claim-all --min-fee 5.00
```

**Close all positions with swap to SOL:**
```bash
node dist/index.js close-all-fast --swap --confirm
```

**View position summary:**
```bash
node dist/index.js summary
```

## Smart Features

### Real-Time USD Thresholds

The tool fetches live SOL prices from CoinGecko to provide accurate USD-to-SOL conversions:

```
📊 Fetching current SOL price...
💲 Current SOL price: $186.14
√ Minimum fee amount to claim (in USD): 5.00
✅ Will only claim fees ≥ $5.00 (~0.026863 SOL at $186.14/SOL)
```

**Benefits:**
- Set thresholds in familiar USD amounts
- Automatically skip positions below your threshold
- Save transaction costs on dust amounts

### Fee Rate Filtering

Meteora pools start at 50% fees and decay over time. The tool allows filtering by current fee rates:

```
🎯 Fee Rate Filtering
√ Close positions in pools with fees ≤ X%: 20
✅ Will close positions in pools with fees ≤ 20% (pools with higher fees will be skipped)
```

**Strategy:**
- Set low percentages (10-20%) to only close pools with favorable fees
- Set 100% to close all positions regardless of fee rates
- Save money by avoiding high-fee transactions

### Multi-Wallet Management

When multiple wallets are detected:

```
🔑 Found 3 wallets in configuration
√ Select wallet to use: 
  Wallet 1 - AbC123...Xyz789
  Wallet 2 - DeF456...Uvw012
  Wallet 3 - GhI789...Rst345
```

**Features:**
- Automatic wallet detection from `.env` file
- Runtime wallet switching without restart
- Clear wallet identification with truncated addresses

## Performance Optimizations

### Rate Limiting
- Respects RPC limits (15 requests/second)
- Smart delays between operations
- Prevents API throttling errors

### Efficient Processing
- Batch operations where possible
- Skip low-value transactions automatically
- Continue processing despite individual failures

## CLI Parameters

### Global Options
- `--min-fee <usd>` - Minimum fee amount in USD (default: 0)
- `--max-deposit <usd>` - Maximum deposit amount in USD to close (positions with higher deposits will be skipped)
- `--swap` - Enable automatic token swapping to SOL
- `--slippage <bps>` - Slippage tolerance in basis points (default: 10)
- `--confirm` - Skip confirmation prompts

### Examples

**Claim fees worth at least $10:**
```bash
node dist/index.js claim-all --min-fee 10.00
```

**Close all positions with 0.5% slippage:**
```bash
node dist/index.js close-all-fast --swap --slippage 50
```

**Close positions with small deposits only:**
```bash
node dist/index.js close-all --max-deposit 50 --swap
```

**Automated closing (no prompts):**
```bash
node dist/index.js close-all-fast --swap --confirm
```

## Security Best Practices

### Private Key Security
- Never share your `.env` file
- Store private keys securely
- Use separate wallets for different purposes

### Transaction Safety
- Test with small amounts first
- Verify transactions on Solscan
- Maintain sufficient SOL for transaction fees
- Review fee rates before closing positions

### RPC Considerations
- Use reliable RPC providers (QuickNode recommended)
- Monitor rate limits and upgrade plans if needed
- Keep backup RPC endpoints available

## Troubleshooting

### Common Issues

**"No positions with fees ≥ $X found"**
- Lower your USD threshold
- Check if positions have claimable fees
- Verify wallet has Meteora positions

**"Rate limit reached"**
- Tool handles this automatically with delays
- Consider upgrading RPC plan for faster processing
- Reduce concurrent operations

**"Invalid private key format"**
- Ensure proper Base58 format or valid Solflare array
- Check for extra spaces or line breaks
- Verify key corresponds to correct wallet

**Multiple wallet issues**
- Ensure wallets are numbered sequentially (PRIVATE_KEY_2, PRIVATE_KEY_3, etc.)
- Both Base58 and array formats supported
- Check for syntax errors in array format

### Performance Tips

**For large position counts:**
- Use higher USD thresholds to reduce processing time
- Enable fee rate filtering to skip unfavorable pools
- Process during off-peak hours for better RPC performance

**For optimal results:**
- Set reasonable slippage (10-50 basis points)
- Use current fee rate data for closing decisions
- Monitor transaction costs vs. fee amounts

## Support

For technical issues:
1. Verify `.env` configuration
2. Test RPC endpoint connectivity
3. Confirm wallet has Meteora positions
4. Check console output for specific error messages
5. Review transaction signatures on Solscan

## Updates and Maintenance

The tool automatically:
- Fetches current SOL prices
- Adapts to RPC rate limits
- Handles network congestion
- Provides detailed transaction feedback

Regular updates may include:
- Enhanced fee calculation algorithms
- Additional RPC provider support
- Improved error handling
- New filtering options