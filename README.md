
# Index contest details

- Join [Sherlock Discord](https://discord.gg/MABEWyASkp)
- Submit findings using the issue page in your private contest repo (label issues as med or high)
- [Read for more details](https://docs.sherlock.xyz/audits/watsons)

# Q&A

### Q: On what chains are the smart contracts going to be deployed?
mainnet, Polygon, Optimism, Avalanche, and Arbitrum
___

### Q: Which ERC20 tokens do you expect will interact with the smart contracts? 
The protocol expects to interact with any ERC20.

Individual SetToken's should only interact with ERC20 chosen by the SetToken manager.
___

### Q: Which ERC721 tokens do you expect will interact with the smart contracts? 
None
___

### Q: Which ERC777 tokens do you expect will interact with the smart contracts? 
The protocol expects to interact with any ERC777.

Individual SetToken's should only interact with ERC777 chosen by the SetToken manager.
___

### Q: Are there any FEE-ON-TRANSFER tokens interacting with the smart contracts?

Not at the moment, but it would be good to know if they can interact with our smart contracts
___

### Q: Are there any REBASING tokens interacting with the smart contracts?

No, for our accounting purposes we look to include wrapped versions of any rebasing tokens
___

### Q: Are the admins of the protocols your contracts integrate with (if any) TRUSTED or RESTRICTED?
TRUSTED
___

### Q: Is the admin/owner of the protocol/contracts TRUSTED or RESTRICTED?
TRUSTED
___

### Q: Are there any additional protocol roles? If yes, please explain in detail:
SetToken Manager
- Whitelisted to manage Modules on the SetToken
- Whitelisted to rebalance the SetToken

SetToken Holders
- Able to mint/redeem for underlying collateral of SetToken
___

### Q: Is the code/contract expected to comply with any EIPs? Are there specific assumptions around adhering to those EIPs that Watsons should be aware of?
No
___

### Q: Please list any known issues/acceptable risks that should not result in a valid finding.
NA
___

### Q: Please provide links to previous audits (if any).
NA
___

### Q: Are there any off-chain mechanisms or off-chain procedures for the protocol (keeper bots, input validation expectations, etc)?
The Aave V3 FLI strategy has keeper bots
___

### Q: In case of external protocol integrations, are the risks of external contracts pausing or executing an emergency withdrawal acceptable? If not, Watsons will submit issues related to these situations that can harm your protocol's functionality.
Acceptable
___



# Audit scope


[index-protocol @ 86be7ee76d9a7e4f7e93acfc533216ebef791c89](https://github.com/IndexCoop/index-protocol/tree/86be7ee76d9a7e4f7e93acfc533216ebef791c89)
- [index-protocol/contracts/protocol/Controller.sol](index-protocol/contracts/protocol/Controller.sol)
- [index-protocol/contracts/protocol/IntegrationRegistry.sol](index-protocol/contracts/protocol/IntegrationRegistry.sol)
- [index-protocol/contracts/protocol/SetToken.sol](index-protocol/contracts/protocol/SetToken.sol)
- [index-protocol/contracts/protocol/SetTokenCreator.sol](index-protocol/contracts/protocol/SetTokenCreator.sol)
- [index-protocol/contracts/protocol/integration/lib/AaveV3.sol](index-protocol/contracts/protocol/integration/lib/AaveV3.sol)
- [index-protocol/contracts/protocol/modules/v1/AaveV3LeverageModule.sol](index-protocol/contracts/protocol/modules/v1/AaveV3LeverageModule.sol)
- [index-protocol/contracts/protocol/modules/v1/AirdropModule.sol](index-protocol/contracts/protocol/modules/v1/AirdropModule.sol)
- [index-protocol/contracts/protocol/modules/v1/AmmModule.sol](index-protocol/contracts/protocol/modules/v1/AmmModule.sol)
- [index-protocol/contracts/protocol/modules/v1/ClaimModule.sol](index-protocol/contracts/protocol/modules/v1/ClaimModule.sol)
- [index-protocol/contracts/protocol/modules/v1/DebtIssuanceModuleV2.sol](index-protocol/contracts/protocol/modules/v1/DebtIssuanceModuleV2.sol)
- [index-protocol/contracts/protocol/modules/v1/TradeModule.sol](index-protocol/contracts/protocol/modules/v1/TradeModule.sol)
- [index-protocol/contracts/protocol/modules/v1/WrapModuleV2.sol](index-protocol/contracts/protocol/modules/v1/WrapModuleV2.sol)
- [index-protocol/contracts/protocol/modules/v1/StreamingFeeModule.sol](index-protocol/contracts/protocol/modules/v1/StreamingFeeModule.sol)

[index-coop-smart-contracts @ 317dfb677e9738fc990cf69d198358065e8cb595](https://github.com/IndexCoop/index-coop-smart-contracts/tree/317dfb677e9738fc990cf69d198358065e8cb595)
- [index-coop-smart-contracts/contracts/adapters/AaveV3LeverageStrategyExtension.sol](index-coop-smart-contracts/contracts/adapters/AaveV3LeverageStrategyExtension.sol)
- [index-coop-smart-contracts/contracts/manager/BaseManagerV2.sol](index-coop-smart-contracts/contracts/manager/BaseManagerV2.sol)


