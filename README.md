# Meteora Position Manager

A powerful command-line tool to manage your Meteora DAMM V2 positions with automated fee claiming, position closing, and token swapping capabilities.

## ✨ Key Features

- 🔑 **Multi-wallet support** - Manage multiple wallets with easy switching
- 💰 **Smart fee claiming** - Real-time USD thresholds with live SOL pricing
- 🔥 **Automated position closing** - Claim fees + close positions + optional token swapping
- 💱 **Jupiter integration** - Convert received tokens to SOL automatically
- 📊 **Position analytics** - Comprehensive position summaries and reporting
- 🎯 **Fee rate filtering** - Only close positions in pools with favorable fee rates
- ⚡ **Rate limit optimization** - Smart delays to prevent RPC throttling
- 🔒 **Dual key format support** - Works with both Base58 and Solflare array formats

## 🚀 Quick Start

### Prerequisites

- **Node.js** (v16 or higher) - [Download here](https://nodejs.org/)
- **Solana wallet** with Meteora positions
- **RPC endpoint** (QuickNode recommended)

### Installation

```bash
# Clone and setup
git clone https://github.com/ImFantin/Meteora-DAMMV2-Position-Manager.git
cd Meteora-DAMMV2-Position-Manager
npm install
npm run build
```

### Configuration

1. **Copy environment template:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` file:**
   ```env
   # Your Solana RPC URL
   RPC_URL=https://your-endpoint.solana-mainnet.quiknode.pro/your-token/

   # Primary wallet (Base58 format)
   PRIVATE_KEY=your_base58_private_key_here

   # Additional wallets (optional)
   # PRIVATE_KEY_2=your_second_wallet_here
   # PRIVATE_KEY_3=[226,238,211,21,151,163,75,132...]  # Solflare array format
   ```

3. **Get your private key:**
   - **Phantom:** Settings → Security & Privacy → Export Private Key
   - **Solflare:** Settings → Security → Export Private Key (supports both formats)

## 📖 Usage

### Interactive Mode (Recommended)

```bash
node dist/index.js
```

**Simple 3-option menu:**
- **💰 Claim All Fees** - Collect fees while keeping original tokens
- **🔥 Close All Positions** - Complete cleanup with optional SOL conversion
- **📊 View Position Summary** - Analyze your positions

### Command Line Interface

```bash
# Claim all fees with USD threshold
node dist/index.js claim-all --min-fee 5.00

# Close all positions with swap to SOL
node dist/index.js close-all-fast --swap --confirm

# View position summary
node dist/index.js summary
```

## 🎯 Smart Features

### Real-Time USD Thresholds
- Fetches live SOL price from CoinGecko
- Set minimum fee amounts in familiar USD values
- Automatically skips positions below your threshold
- Example: `$5.00` minimum = skip fees worth less than $5

### Fee Rate Filtering
- Meteora pools start at 50% fees and decay over time
- Filter to only close positions in pools with lower fees
- Example: Set 20% to only close pools with ≤20% current fees
- Saves money by avoiding high-fee pool transactions

### Multi-Wallet Management
- Automatically detects multiple wallets in `.env`
- Easy wallet switching during runtime
- Supports both Base58 and Solflare array formats
- Clear wallet identification with truncated addresses

## 📊 Example Workflow

```
🌊 Welcome to Meteora Fee Claimer & Position Manager
════════════════════════════════════════════════════════════
🔑 Using Wallet 1: AG8F9tam...
🔑 Wallet 1 Info:
   Address: AG8F9tamsLbjENSjvjRmF5rcqxCTu7Q1YEkmb6veVCtE
   Balance: 3.6245 SOL

√ What would you like to do? (Current: Wallet 1) 💰 Claim All Fees

💰 Minimum Fee Threshold
📊 Fetching current SOL price...
💲 Current SOL price: $186.14
√ Minimum fee amount to claim (in USD): 5.00
✅ Will only claim fees ≥ $5.00 (~0.026863 SOL at $186.14/SOL)

🔍 Scanning all positions for claimable fees...
📊 Found 136 total position(s)
💰 Found 5 position(s) with fees ≥ $5.00
   (131 position(s) skipped due to low fees)

[1/5] Processing position 5RJxRBwY...
   Claimable fees: 229821406 (B)
✅ Fees claimed! Signature: 4Rru5RcnTjw6EiwCdyTSdWkZwpSBfc7f8a38RKynzwkU...

📈 Summary:
   Positions processed: 5
   Successful claims: 5
   Failed claims: 0

🎉 All qualifying fees claimed successfully!
```

## ⚙️ Advanced Options

### CLI Parameters

```bash
# Claim fees with minimum threshold
node dist/index.js claim-all --min-fee 10.00

# Close positions with specific settings
node dist/index.js close-all-fast --swap --slippage 20 --min-value 150000

# Skip confirmation prompts
node dist/index.js close-all-fast --swap --confirm
```

### Slippage Control
- Default: 10 basis points (0.1%)
- Volatile tokens: 50+ basis points (0.5%+)
- Stable swaps: 5-10 basis points

### Value Filtering
- `--min-value 150000` = Skip tokens worth less than ~$0.15
- `--min-value 1000000` = Skip tokens worth less than ~$1.00
- Prevents wasting gas on dust tokens

## 🛡️ Security & Best Practices

### Security Features
- ✅ Private keys stored locally only
- ✅ No external data transmission
- ✅ All transactions signed locally
- ✅ Open source and auditable

### Best Practices
- 🔒 Never share your `.env` file
- 💾 Backup private keys securely
- 🧪 Test with small amounts first
- 📊 Verify transactions on Solscan
- ⛽ Maintain sufficient SOL for fees

## 🔧 Troubleshooting

### Common Issues

**"No positions with fees ≥ $X found"**
- Lower your USD threshold
- Check if you have any claimable fees

**"Rate limit reached"**
- Tool automatically handles this with delays
- Consider upgrading your RPC plan for faster processing

**"Invalid private key format"**
- Ensure proper Base58 format or valid Solflare array
- Check for extra spaces or characters

**Multiple wallet detection**
- Add wallets as `PRIVATE_KEY_2`, `PRIVATE_KEY_3`, etc.
- Both Base58 and array formats supported

## 📈 Performance Optimizations

- **Smart rate limiting** - Respects RPC limits (15 req/sec)
- **Efficient batching** - Processes positions optimally
- **Real-time pricing** - Accurate USD conversions
- **Selective processing** - Skip low-value operations

## 🤝 Support

For issues or questions:
1. Check your `.env` configuration
2. Verify RPC endpoint connectivity
3. Confirm wallet has Meteora positions
4. Review console output for specific errors

## � Supeport the Project

If this tool has helped you efficiently manage your Meteora positions and saved you valuable time, consider buying me a coffee! ☕

**If you feel sharing some love:** `2Y3MR5qDwNBrJK8fYxvaXdhSxKEcoDuyxsy8xCcnzk37`

Every contribution, no matter how small, helps keep this project alive and motivates continued development for the community! Your support means the world to me. 🙏✨

## 📄 License

MIT License - Use at your own risk. No warranties provided.

---

**⚠️ Disclaimer:** This tool interacts with your wallet and performs transactions. Always verify transactions and use at your own risk. The authors are not responsible for any losses.