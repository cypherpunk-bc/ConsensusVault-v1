.PHONY: deploy-testnet deploy-commentvault-bsctestnet deploy-commentvault-bscmainnet

# 部署并自动在 BscScan 上验证合约代码
deploy-bsctestnet:
	forge script script/DeployFactory.s.sol:DeployFactory \
		--rpc-url $(BSC_TESTNET_RPC_URL) \
		--private-key $(PRIVATE_KEY) \
		--broadcast \
		--verify \
		--etherscan-api-key $(ETHERSCAN_API_KEY) \
		-vvvv

# 部署并自动在 Bsc 主网 上验证合约代码
deploy-bscmainnet:
	forge script script/DeployFactory.s.sol:DeployFactory \
		--rpc-url $(BSC_MAINNET_RPC_URL) \
		--private-key $(PRIVATE_KEY) \
		--broadcast \
		--verify \
		--etherscan-api-key $(ETHERSCAN_API_KEY) \
		-vvvv

# 部署 CommentVault 到 BSC 测试网
deploy-commentvault-bsctestnet:
	@echo "部署 CommentVault 到 BSC 测试网..."
	forge script script/DeployCommentVault.s.sol:DeployCommentVault \
		--rpc-url $(BSC_TESTNET_RPC_URL) \
		--private-key $(PRIVATE_KEY) \
		--broadcast \
		--verify \
		--etherscan-api-key $(ETHERSCAN_API_KEY) \
		-vvvv

# 部署 CommentVault 到 BSC 主网
deploy-commentvault-bscmainnet:
	@echo "部署 CommentVault 到 BSC 主网..."
	forge script script/DeployCommentVault.s.sol:DeployCommentVault \
		--rpc-url $(BSC_MAINNET_RPC_URL) \
		--private-key $(PRIVATE_KEY) \
		--broadcast \
		--verify \
		--etherscan-api-key $(ETHERSCAN_API_KEY) \
		-vvvv

