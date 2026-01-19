.PHONY: deploy-testnet

# 部署并自动在 BscScan 上验证合约代码
deploy-bsctestnet:
	forge script script/DeployFactory.s.sol:DeployFactory \
		--rpc-url $(BSC_TESTNET_RPC_URL) \
		--private-key $(PRIVATE_KEY) \
		--broadcast \
		--verify \
		--etherscan-api-key $(ETHERSCAN_API_KEY) \
		-vvvv

		