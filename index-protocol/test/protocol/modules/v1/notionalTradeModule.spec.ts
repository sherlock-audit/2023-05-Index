import "module-alias/register";
import { BigNumber } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { ethers, network } from "hardhat";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ManagerIssuanceHookMock,
  NotionalTradeModule,
  NotionalV2Mock,
  DebtIssuanceModule,
  DebtIssuanceMock,
  SetToken,
  StandardTokenMock,
  WrappedfCashMock,
  WrappedfCashFactoryMock,
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  getAccounts,
  getCompoundFixture,
  getRandomAccount,
  getRandomAddress,
  getSystemFixture,
  getWaffleExpect,
  convertPositionToNotional,
  convertNotionalToPosition,
} from "@utils/test/index";
import { CompoundFixture, SystemFixture } from "@utils/fixtures";
import { ADDRESS_ZERO } from "@utils/constants";
import { CERc20 } from "@utils/contracts/compound";
import { IERC20 } from "@typechain/IERC20";
import { mintWrappedFCash } from "../../../integration/notionalTradeModule/utils";

const expect = getWaffleExpect();

describe("NotionalTradeModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let manager: Account;
  let setup: SystemFixture;

  let mockPreIssuanceHook: ManagerIssuanceHookMock;
  let debtIssuanceModule: DebtIssuanceModule;

  let compoundSetup: CompoundFixture;
  let cTokenInitialMantissa: BigNumber;

  let usdc: StandardTokenMock;

  before(async () => {
    [owner, manager] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();
    cTokenInitialMantissa = ether(200000000);
    mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
    usdc = setup.usdc;
  });

  describe("when notionalV2 / factory mocks are deployed", async () => {
    let wrappedfCashFactoryMock: WrappedfCashFactoryMock;
    let notionalV2Mock: NotionalV2Mock;
    let snapshotId: number;
    before(async () => {
      wrappedfCashFactoryMock = await deployer.mocks.deployWrappedfCashFactoryMock();
      notionalV2Mock = await deployer.mocks.deployNotionalV2Mock();
    });

    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
      await network.provider.send("evm_revert", [snapshotId]);
    });

    describe("#constructor", async () => {
      let subjectController: Address;
      let subjectWrappedfCashFactory: Address;
      let subjectWeth: Address;
      let subjectNotionalV2: Address;
      let subjectDecodedIdGasLimit: number;

      beforeEach(async () => {
        subjectController = setup.controller.address;
        subjectWrappedfCashFactory = wrappedfCashFactoryMock.address;
        subjectDecodedIdGasLimit = 10 ** 6;
        subjectNotionalV2 = notionalV2Mock.address;
        subjectWeth = setup.weth.address;
      });

      async function subject(): Promise<NotionalTradeModule> {
        return deployer.modules.deployNotionalTradeModule(
          subjectController,
          subjectWrappedfCashFactory,
          subjectWeth,
          subjectNotionalV2,
          subjectDecodedIdGasLimit,
        );
      }

      it("should set the correct controller", async () => {
        const notionalTradeModule = await subject();

        const controller = await notionalTradeModule.controller();
        expect(controller).to.eq(subjectController);
      });

      it("should set the decodedIdGasLimit", async () => {
        const notionalTradeModule = await subject();

        const decodedIdGasLimit = await notionalTradeModule.decodedIdGasLimit();
        expect(decodedIdGasLimit).to.eq(subjectDecodedIdGasLimit);
      });

      describe("when wrappedFCashFactory is zero address", () => {
        beforeEach(async () => {
          subjectWrappedfCashFactory = ADDRESS_ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("WrappedfCashFactory address cannot be zero");
        });
      });

      describe("when NotionalV2 is zero address", () => {
        beforeEach(async () => {
          subjectNotionalV2 = ADDRESS_ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("NotionalV2 address cannot be zero");
        });
      });

      describe("when Weth is zero address", () => {
        beforeEach(async () => {
          subjectWeth = ADDRESS_ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Weth address cannot be zero");
        });
      });
    });

    describe("When notional module is deployed", async () => {
      let notionalTradeModule: NotionalTradeModule;
      beforeEach(async () => {
        const decodedIdGaslimit = 10 ** 6;
        notionalTradeModule = await deployer.modules.deployNotionalTradeModule(
          setup.controller.address,
          wrappedfCashFactoryMock.address,
          setup.weth.address,
          notionalV2Mock.address,
          decodedIdGaslimit,
        );
        await setup.controller.addModule(notionalTradeModule.address);

        debtIssuanceModule = await deployer.modules.deployDebtIssuanceModuleV2(
          setup.controller.address,
        );
        await setup.controller.addModule(debtIssuanceModule.address);
        await setup.integrationRegistry.addIntegration(
          notionalTradeModule.address,
          "DefaultIssuanceModule",
          debtIssuanceModule.address,
        );
      });

      ["dai", "weth"].forEach(underlyingTokenName => {
        describe(`When underlying token is ${underlyingTokenName}`, () => {
          let assetToken: CERc20;
          let underlyingToken: StandardTokenMock;

          beforeEach(async () => {
            // @ts-ignore
            underlyingToken = setup[underlyingTokenName];
            assetToken = await compoundSetup.createAndEnableCToken(
              underlyingToken.address,
              cTokenInitialMantissa,
              compoundSetup.comptroller.address,
              compoundSetup.interestRateModel.address,
              "Compound UnderlyingToken",
              "cUNDERLYINGTOKEN",
              8,
              ether(0.75), // 75% collateral factor
              ether(1),
            );
            await underlyingToken.approve(assetToken.address, ethers.constants.MaxUint256);
            await assetToken.mint(ether(100));

            mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
          });
          describe("When wrappedFCashMock is deployed", async () => {
            let wrappedfCashMock: WrappedfCashMock;
            let underlyingTokenBalance: BigNumber;
            let currencyId: number;
            let maturity: number;
            beforeEach(async () => {
              const underlyingAddress =
                underlyingToken.address == setup.weth.address
                  ? ADDRESS_ZERO
                  : underlyingToken.address;
              const isEth = underlyingToken.address == setup.weth.address;
              wrappedfCashMock = await deployer.mocks.deployWrappedfCashMock(
                assetToken.address,
                underlyingAddress,
                setup.weth.address,
                isEth,
              );
              currencyId = 1;
              maturity = (await ethers.provider.getBlock("latest")).timestamp + 30 * 24 * 3600;

              await wrappedfCashMock.initialize(currencyId, maturity);

              await wrappedfCashFactoryMock.registerWrapper(
                currencyId,
                maturity,
                wrappedfCashMock.address,
              );

              underlyingTokenBalance = ether(100);
              await underlyingToken.transfer(owner.address, underlyingTokenBalance);
              await underlyingToken.approve(wrappedfCashMock.address, underlyingTokenBalance);

              await wrappedfCashMock.mintViaUnderlying(
                underlyingTokenBalance,
                underlyingTokenBalance,
                owner.address,
                0,
              );
            });
            describe("When setToken is deployed", async () => {
              let usdcPosition: BigNumber;
              let initialSetBalance: BigNumber;
              let setToken: SetToken;
              beforeEach(async () => {
                usdcPosition = ethers.utils.parseUnits("2", await usdc.decimals());

                setToken = await setup.createSetToken(
                  [usdc.address],
                  [usdcPosition],
                  [debtIssuanceModule.address, notionalTradeModule.address],
                  manager.address,
                );

                expect(await setToken.isPendingModule(debtIssuanceModule.address)).to.be.true;

                // Initialize debIssuance module
                await debtIssuanceModule.connect(manager.wallet).initialize(
                  setToken.address,
                  ether(0.1),
                  ether(0), // No issue fee
                  ether(0), // No redeem fee
                  owner.address,
                  mockPreIssuanceHook.address,
                );

                initialSetBalance = underlyingTokenBalance.div(10);
                await usdc.approve(debtIssuanceModule.address, underlyingTokenBalance);
                await debtIssuanceModule.issue(setToken.address, initialSetBalance, owner.address);
              });

              describe("#updateDecodedIdGaslimit", async () => {
                let caller: SignerWithAddress;
                let subjectDecodedIdGasLimit: number;

                beforeEach(async () => {
                  caller = owner.wallet;
                  subjectDecodedIdGasLimit = 10 ** 5;
                });
                const subject = () => {
                  return notionalTradeModule
                    .connect(caller)
                    .updateDecodedIdGasLimit(subjectDecodedIdGasLimit);
                };
                it("adjusts gas limit correctly", async () => {
                  await subject();
                  const decodedIdGasLimit = await notionalTradeModule.decodedIdGasLimit();
                  expect(decodedIdGasLimit).to.eq(subjectDecodedIdGasLimit);
                });

                describe("when the caller is not the owner", async () => {
                  beforeEach(async () => {
                    caller = manager.wallet;
                  });
                  it("should revert", async () => {
                    await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
                  });
                });

                describe("when the new limit is zero", async () => {
                  beforeEach(async () => {
                    subjectDecodedIdGasLimit = 0;
                  });
                  it("should revert", async () => {
                    await expect(subject()).to.be.revertedWith("DecodedIdGasLimit cannot be zero");
                  });
                });
              });

              describe("#updateAnySetAllowed", async () => {
                let caller: SignerWithAddress;
                let subjectStatus: boolean;

                beforeEach(async () => {
                  caller = owner.wallet;
                });

                const subject = () => {
                  return notionalTradeModule.connect(caller).updateAnySetAllowed(subjectStatus);
                };
                describe("when setting to true", () => {
                  beforeEach(async () => {
                    subjectStatus = true;
                  });
                  it("updates allowedSetTokens", async () => {
                    await subject();
                    expect(await notionalTradeModule.anySetAllowed()).to.be.true;
                  });
                  describe("when caller is not the owner", () => {
                    beforeEach(() => {
                      caller = manager.wallet;
                    });
                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith(
                        "Ownable: caller is not the owner",
                      );
                    });
                  });
                });
              });

              describe("#updateAllowedSetToken", async () => {
                let caller: SignerWithAddress;
                let subjectSetToken: Address;
                let subjectStatus: boolean;

                beforeEach(async () => {
                  caller = owner.wallet;
                });

                const subject = () => {
                  return notionalTradeModule
                    .connect(caller)
                    .updateAllowedSetToken(subjectSetToken, subjectStatus);
                };
                describe("when adding a new allowed set token", () => {
                  beforeEach(async () => {
                    subjectStatus = true;
                  });
                  describe("when set token is invalid", () => {
                    beforeEach(() => {
                      subjectSetToken = ethers.constants.AddressZero;
                    });
                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith("Invalid SetToken");
                    });
                  });
                  describe("when set token is valid", () => {
                    beforeEach(() => {
                      subjectSetToken = setToken.address;
                    });
                    it("updates allowedSetTokens", async () => {
                      await subject();
                      expect(await notionalTradeModule.allowedSetTokens(subjectSetToken)).to.be
                        .true;
                    });
                  });
                  describe("when caller is not the owner", () => {
                    beforeEach(() => {
                      caller = manager.wallet;
                    });
                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith(
                        "Ownable: caller is not the owner",
                      );
                    });
                  });
                });
                describe("when removing an allowed set token", () => {
                  beforeEach(async () => {
                    subjectSetToken = setToken.address;
                    subjectStatus = false;
                    await notionalTradeModule
                      .connect(owner.wallet)
                      .updateAllowedSetToken(subjectSetToken, true);
                  });
                  it("updates allowedSetTokens", async () => {
                    expect(await notionalTradeModule.allowedSetTokens(subjectSetToken)).to.be.true;
                    await subject();
                    expect(await notionalTradeModule.allowedSetTokens(subjectSetToken)).to.be.false;
                  });
                });
              });

              describe("#initialize", async () => {
                let isAllowListed: boolean = true;
                let subjectSetToken: Address;
                let subjectCaller: Account;

                beforeEach(async () => {
                  if (isAllowListed) {
                    // Add SetToken to allow list
                    await notionalTradeModule.updateAllowedSetToken(setToken.address, true);
                  }

                  subjectSetToken = setToken.address;
                  subjectCaller = manager;
                });

                async function subject(): Promise<any> {
                  return notionalTradeModule
                    .connect(subjectCaller.wallet)
                    .initialize(subjectSetToken);
                }

                describe("when isAllowListed is true", () => {
                  before(async () => {
                    isAllowListed = true;
                  });

                  it("should enable the Module on the SetToken", async () => {
                    await subject();
                    const isModuleEnabled = await setToken.isInitializedModule(
                      notionalTradeModule.address,
                    );
                    expect(isModuleEnabled).to.eq(true);
                  });

                  describe("when non contract module is added to integration registry", async () => {
                    beforeEach(async () => {
                      const nonContractModule = owner.address;
                      await setup.controller.addModule(nonContractModule);
                      await setToken.connect(manager.wallet).addModule(nonContractModule);
                      await setToken.connect(owner.wallet).initializeModule();
                    });

                    it("should enable the Module on the SetToken", async () => {
                      await subject();
                      const isModuleEnabled = await setToken.isInitializedModule(
                        notionalTradeModule.address,
                      );
                      expect(isModuleEnabled).to.eq(true);
                    });
                  });

                  describe("when debt issuance module is not added to integration registry", async () => {
                    beforeEach(async () => {
                      await setup.integrationRegistry.removeIntegration(
                        notionalTradeModule.address,
                        "DefaultIssuanceModule",
                      );
                    });

                    afterEach(async () => {
                      // Add debt issuance address to integration
                      await setup.integrationRegistry.addIntegration(
                        notionalTradeModule.address,
                        "DefaultIssuanceModule",
                        debtIssuanceModule.address,
                      );
                    });

                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith("Must be valid adapter");
                    });
                  });

                  describe("when debt issuance module is not initialized on SetToken", async () => {
                    beforeEach(async () => {
                      await setToken
                        .connect(manager.wallet)
                        .removeModule(debtIssuanceModule.address);
                    });

                    afterEach(async () => {
                      await setToken.connect(manager.wallet).addModule(debtIssuanceModule.address);
                      // Initialize debIssuance module
                      await debtIssuanceModule.connect(manager.wallet).initialize(
                        setToken.address,
                        ether(0.1),
                        ether(0), // No issue fee
                        ether(0), // No redeem fee
                        owner.address,
                        mockPreIssuanceHook.address,
                      );
                    });

                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith("Issuance not initialized");
                    });
                  });

                  describe("when the caller is not the SetToken manager", async () => {
                    beforeEach(async () => {
                      subjectCaller = await getRandomAccount();
                    });

                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
                    });
                  });

                  describe("when SetToken is not in pending state", async () => {
                    beforeEach(async () => {
                      const newModule = await getRandomAddress();
                      await setup.controller.addModule(newModule);

                      const notionalTradeModuleNotPendingSetToken = await setup.createSetToken(
                        [setup.weth.address],
                        [ether(1)],
                        [newModule],
                        manager.address,
                      );

                      subjectSetToken = notionalTradeModuleNotPendingSetToken.address;
                    });

                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith("Must be pending initialization");
                    });
                  });

                  describe("when the SetToken is not enabled on the controller", async () => {
                    beforeEach(async () => {
                      const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
                        [setup.weth.address],
                        [ether(1)],
                        [notionalTradeModule.address],
                        manager.address,
                      );

                      subjectSetToken = nonEnabledSetToken.address;
                    });

                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith(
                        "Must be controller-enabled SetToken",
                      );
                    });
                  });
                });

                describe("when isAllowListed is false", async () => {
                  before(async () => {
                    isAllowListed = false;
                  });

                  describe("when SetToken is not allowlisted", async () => {
                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith("Not allowed SetToken");
                    });
                  });

                  describe("when any Set can initialize this module", async () => {
                    beforeEach(async () => {
                      await notionalTradeModule.updateAnySetAllowed(true);
                    });

                    it("should enable the Module on the SetToken", async () => {
                      await subject();
                      const isModuleEnabled = await setToken.isInitializedModule(
                        notionalTradeModule.address,
                      );
                      expect(isModuleEnabled).to.eq(true);
                    });
                  });
                });
              });

              describe("when set token is allowed", () => {
                beforeEach(async () => {
                  await notionalTradeModule.updateAllowedSetToken(setToken.address, true);
                });

                describe("when token is initialized on the notional module", () => {
                  beforeEach(async () => {
                    await notionalTradeModule.connect(manager.wallet).initialize(setToken.address);
                  });

                  describe("#registerToModule", () => {
                    let caller: SignerWithAddress;
                    let subjectSetToken: Address;
                    let subjectIssuanceModule: Address;
                    let newIssuanceModule: DebtIssuanceMock;

                    const subject = () => {
                      return notionalTradeModule
                        .connect(caller)
                        .registerToModule(subjectSetToken, subjectIssuanceModule);
                    };

                    beforeEach(async () => {
                      caller = manager.wallet;
                      subjectSetToken = setToken.address;
                      newIssuanceModule = await deployer.mocks.deployDebtIssuanceMock();
                      await setup.controller.addModule(newIssuanceModule.address);
                      await setToken.connect(manager.wallet).addModule(newIssuanceModule.address);
                      subjectIssuanceModule = newIssuanceModule.address;
                    });

                    describe("when token is initialized on new issuance module", () => {
                      beforeEach(async () => {
                        await newIssuanceModule.initialize(setToken.address);
                      });

                      it("should not revert", async () => {
                        await subject();
                      });
                    });

                    describe("when token is NOT initialized on new issuance module", () => {
                      it("should revert", async () => {
                        await expect(subject()).to.be.revertedWith("Issuance not initialized");
                      });
                    });
                  });

                  describe("#updateRedemptionHookDisabled", async () => {
                    let caller: SignerWithAddress;
                    let subjectIsDisabled: boolean;

                    beforeEach(async () => {
                      caller = manager.wallet;
                      subjectIsDisabled = true;
                    });
                    const subject = () => {
                      return notionalTradeModule
                        .connect(caller)
                        .updateRedemptionHookDisabled(setToken.address, subjectIsDisabled);
                    };

                    describe("when disabling previously enabled token", () => {
                      beforeEach(async () => {
                        const isDisabled = await notionalTradeModule.redemptionHookDisabled(
                          setToken.address,
                        );
                        expect(isDisabled).to.eq(false);
                      });
                      it("adjusts state corectly", async () => {
                        await subject();
                        const isDisabled = await notionalTradeModule.redemptionHookDisabled(
                          setToken.address,
                        );
                        expect(isDisabled).to.eq(subjectIsDisabled);
                      });
                    });

                    describe("when enabling previously disabled token", () => {
                      beforeEach(async () => {
                        await notionalTradeModule
                          .connect(manager.wallet)
                          .updateRedemptionHookDisabled(setToken.address, true);
                        const isDisabled = await notionalTradeModule.redemptionHookDisabled(
                          setToken.address,
                        );
                        expect(isDisabled).to.eq(true);
                        subjectIsDisabled = false;
                      });
                      it("adjusts state corectly", async () => {
                        await subject();
                        const isDisabled = await notionalTradeModule.redemptionHookDisabled(
                          setToken.address,
                        );
                        expect(isDisabled).to.eq(subjectIsDisabled);
                      });
                    });

                    describe("when the caller is not the manager", async () => {
                      beforeEach(async () => {
                        caller = owner.wallet;
                      });
                      it("should revert", async () => {
                        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
                      });
                    });
                  });
                  describe("#setRedeemToUnderlying", () => {
                    let subjectSetToken: string;
                    let subjectToUnderlying: boolean;
                    let caller: SignerWithAddress;
                    const subject = () => {
                      return notionalTradeModule
                        .connect(caller)
                        .setRedeemToUnderlying(subjectSetToken, subjectToUnderlying);
                    };
                    beforeEach(() => {
                      subjectSetToken = setToken.address;
                      subjectToUnderlying = true;
                      caller = manager.wallet;
                    });
                    describe("when setting to true", () => {
                      it("should adjust the state correctly", async () => {
                        await subject();
                        expect(await notionalTradeModule.redeemToUnderlying(subjectSetToken)).to.be
                          .true;
                      });
                      describe("when caller is not the manager", () => {
                        beforeEach(() => {
                          caller = owner.wallet;
                        });
                        it("should revert", async () => {
                          await expect(subject()).to.be.revertedWith(
                            "Must be the SetToken manager",
                          );
                        });
                      });
                    });

                    describe("when setting to false", () => {
                      beforeEach(async () => {
                        subjectToUnderlying = false;
                        await notionalTradeModule
                          .connect(manager.wallet)
                          .setRedeemToUnderlying(subjectSetToken, true);
                        expect(await notionalTradeModule.redeemToUnderlying(subjectSetToken)).to.be
                          .true;
                      });
                      it("should adjust the state correctly", async () => {
                        await subject();
                        expect(await notionalTradeModule.redeemToUnderlying(subjectSetToken)).to.be
                          .false;
                      });
                    });
                  });

                  describe("#getFCashComponents", () => {
                    let subjectSetToken: string;
                    const subject = () => {
                      return notionalTradeModule.getFCashComponents(subjectSetToken);
                    };
                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      await setup.controller.connect(owner.wallet).addModule(owner.address);
                      await setToken.connect(manager.wallet).addModule(owner.address);
                      await setToken.connect(owner.wallet).initializeModule();
                    });
                    describe("When set token has fCash position", () => {
                      beforeEach(async () => {
                        const fCashPosition = 1000;
                        await setToken.connect(owner.wallet).addComponent(wrappedfCashMock.address);
                        await setToken
                          .connect(owner.wallet)
                          .editDefaultPositionUnit(wrappedfCashMock.address, fCashPosition);
                      });

                      it("should return the correct fCash positions", async () => {
                        const fCashComponents = await subject();
                        expect(fCashComponents).to.deep.eq([wrappedfCashMock.address]);
                      });
                      describe("When the unit is negative", () => {
                        beforeEach(async () => {
                          await setToken
                            .connect(owner.wallet)
                            .editDefaultPositionUnit(wrappedfCashMock.address, -420);
                          const externalPositionModule = await getRandomAddress();
                          await setToken
                            .connect(owner.wallet)
                            .addExternalPositionModule(
                              wrappedfCashMock.address,
                              externalPositionModule,
                            );
                          await setToken
                            .connect(owner.wallet)
                            .editExternalPositionUnit(
                              wrappedfCashMock.address,
                              externalPositionModule,
                              -420,
                            );
                        });
                        it("should not return the fCash component", async () => {
                          const fCashComponents = await subject();
                          expect(fCashComponents).to.deep.eq([]);
                        });
                      });
                    });
                  });
                  ["buying", "selling"].forEach(tradeDirection => {
                    ["fCash", "inputToken"].forEach(fixedSide => {
                      const functionName =
                        tradeDirection == "buying"
                          ? fixedSide == "fCash"
                            ? "mintFixedFCashForToken"
                            : "mintFCashForFixedToken"
                          : fixedSide == "fCash"
                            ? "redeemFixedFCashForToken"
                            : "redeemFCashForFixedToken";
                      describe(`#${functionName}`, () => {
                        let receiveToken: IERC20;
                        let sendToken: IERC20;
                        let subjectSetToken: string;
                        let subjectSendToken: string;
                        let subjectSendQuantity: BigNumber;
                        let subjectReceiveToken: string;
                        let subjectMinReceiveQuantity: BigNumber;
                        let subjectMaxReceiveAmountDeviation: BigNumber;
                        let subjectCurrencyId: number;
                        let subjectMaturity: number | BigNumber;
                        let caller: SignerWithAddress;

                        beforeEach(async () => {
                          subjectSetToken = setToken.address;
                          caller = manager.wallet;
                          subjectCurrencyId = currencyId;
                          subjectMaturity = maturity;
                        });
                        ["assetToken", "underlyingToken"].forEach(tokenType => {
                          describe(`When ${tradeDirection} fCash for ${tokenType}`, () => {
                            let otherToken: IERC20;
                            beforeEach(async () => {
                              otherToken = tokenType == "assetToken" ? assetToken : underlyingToken;
                              sendToken =
                                tradeDirection == "buying" ? otherToken : wrappedfCashMock;
                              subjectSendToken = sendToken.address;

                              receiveToken =
                                tradeDirection == "buying" ? wrappedfCashMock : otherToken;
                              subjectReceiveToken = receiveToken.address;

                              subjectSendQuantity = BigNumber.from(10000);
                              subjectMinReceiveQuantity = BigNumber.from(10000);

                              if (functionName == "redeemFCashForFixedToken") {
                                // Allow 1 basispoints in inacuracy of the notional calculation method
                                subjectMaxReceiveAmountDeviation = ethers.utils.parseEther(
                                  "0.0001",
                                );
                              }

                              await sendToken.transfer(
                                setToken.address,
                                subjectSendQuantity.mul(2),
                              );
                              await receiveToken.transfer(
                                wrappedfCashMock.address,
                                await convertPositionToNotional(
                                  subjectMinReceiveQuantity.mul(2),
                                  setToken,
                                ),
                              );
                              expect(
                                await receiveToken.balanceOf(wrappedfCashMock.address),
                              ).to.be.gte(subjectMinReceiveQuantity.mul(2));
                            });

                            const subject = () => {
                              if (functionName == "mintFixedFCashForToken") {
                                return notionalTradeModule
                                  .connect(caller)
                                  .mintFixedFCashForToken(
                                    subjectSetToken,
                                    subjectCurrencyId,
                                    subjectMaturity,
                                    subjectMinReceiveQuantity,
                                    subjectSendToken,
                                    subjectSendQuantity,
                                  );
                              }
                              if (functionName == "mintFCashForFixedToken") {
                                return notionalTradeModule
                                  .connect(caller)
                                  .mintFCashForFixedToken(
                                    subjectSetToken,
                                    subjectCurrencyId,
                                    subjectMaturity,
                                    subjectMinReceiveQuantity,
                                    subjectSendToken,
                                    subjectSendQuantity,
                                  );
                              }
                              if (functionName == "redeemFixedFCashForToken") {
                                return notionalTradeModule
                                  .connect(caller)
                                  .redeemFixedFCashForToken(
                                    subjectSetToken,
                                    subjectCurrencyId,
                                    subjectMaturity,
                                    subjectSendQuantity,
                                    subjectReceiveToken,
                                    subjectMinReceiveQuantity,
                                  );
                              }
                              if (functionName == "redeemFCashForFixedToken") {
                                return notionalTradeModule
                                  .connect(caller)
                                  .redeemFCashForFixedToken(
                                    subjectSetToken,
                                    subjectCurrencyId,
                                    subjectMaturity,
                                    subjectSendQuantity,
                                    subjectReceiveToken,
                                    subjectMinReceiveQuantity,
                                    subjectMaxReceiveAmountDeviation,
                                  );
                              }
                              throw Error(`Invalid function name: ${functionName}`);
                            };

                            const subjectCall = () => {
                              if (functionName == "mintFixedFCashForToken") {
                                return notionalTradeModule
                                  .connect(caller)
                                  .callStatic.mintFixedFCashForToken(
                                    subjectSetToken,
                                    subjectCurrencyId,
                                    subjectMaturity,
                                    subjectMinReceiveQuantity,
                                    subjectSendToken,
                                    subjectSendQuantity,
                                  );
                              }
                              if (functionName == "mintFCashForFixedToken") {
                                return notionalTradeModule
                                  .connect(caller)
                                  .callStatic.mintFCashForFixedToken(
                                    subjectSetToken,
                                    subjectCurrencyId,
                                    subjectMaturity,
                                    subjectMinReceiveQuantity,
                                    subjectSendToken,
                                    subjectSendQuantity,
                                  );
                              }
                              if (functionName == "redeemFixedFCashForToken") {
                                return notionalTradeModule
                                  .connect(caller)
                                  .callStatic.redeemFixedFCashForToken(
                                    subjectSetToken,
                                    subjectCurrencyId,
                                    subjectMaturity,
                                    subjectSendQuantity,
                                    subjectReceiveToken,
                                    subjectMinReceiveQuantity,
                                  );
                              }
                              if (functionName == "redeemFCashForFixedToken") {
                                return notionalTradeModule
                                  .connect(caller)
                                  .callStatic.redeemFCashForFixedToken(
                                    subjectSetToken,
                                    subjectCurrencyId,
                                    subjectMaturity,
                                    subjectSendQuantity,
                                    subjectReceiveToken,
                                    subjectMinReceiveQuantity,
                                    subjectMaxReceiveAmountDeviation,
                                  );
                              }
                              throw Error(`Invalid function name: ${functionName}`);
                            };
                            describe("When sendToken is not a registered component", () => {
                              beforeEach(async () => {
                                const sendTokenBalance = await sendToken.balanceOf(
                                  setToken.address,
                                );
                                const sendTokenPosition = await setToken.getTotalComponentRealUnits(
                                  sendToken.address,
                                );

                                // Assert that set token has positive send token balance but it's not a registered component
                                expect(sendTokenBalance).to.be.gte(subjectSendQuantity);
                                expect(sendTokenPosition).to.eq(0);
                                expect(await setToken.isComponent(sendToken.address)).to.be.false;
                              });
                              it("should revert", async () => {
                                const revertMessage =
                                  tradeDirection == "selling"
                                    ? "FCash to redeem must be an index component"
                                    : "Send token must be an index component";
                                await expect(subject()).to.be.revertedWith(revertMessage);
                              });
                            });

                            describe("When sendToken is a registered component", () => {
                              beforeEach(async () => {
                                const sendTokenBalanceBefore = await sendToken.balanceOf(
                                  setToken.address,
                                );

                                const sendTokenPositionToSet = await convertNotionalToPosition(
                                  sendTokenBalanceBefore,
                                  setToken,
                                );

                                await setup.controller
                                  .connect(owner.wallet)
                                  .addModule(owner.address);
                                await setToken.connect(manager.wallet).addModule(owner.address);
                                await setToken.connect(owner.wallet).initializeModule();
                                await setToken
                                  .connect(owner.wallet)
                                  .addComponent(sendToken.address);
                                await setToken
                                  .connect(owner.wallet)
                                  .editDefaultPositionUnit(
                                    sendToken.address,
                                    sendTokenPositionToSet,
                                  );

                                const sendTokenBalanceAfter = await sendToken.balanceOf(
                                  setToken.address,
                                );
                                const sendTokenPositionAfter = await setToken.getTotalComponentRealUnits(
                                  sendToken.address,
                                );

                                // Make sure set token was added to set
                                expect(sendTokenBalanceAfter).to.be.gte(subjectSendQuantity);
                                expect(sendTokenPositionAfter).to.be.gt(0);
                                expect(await setToken.isComponent(sendToken.address)).to.be.true;
                                subjectMinReceiveQuantity = BigNumber.from(10000);
                              });
                              ["less", "equal", "higher"].forEach(relativeAmount => {
                                describe(`when amount of send token spent is ${relativeAmount} than/to registered position`, () => {
                                  beforeEach(async () => {
                                    const sendTokenPosition = await setToken.getDefaultPositionRealUnit(
                                      sendToken.address,
                                    );
                                    await wrappedfCashMock.setRedeemTokenReturned(
                                      await convertPositionToNotional(
                                        subjectMinReceiveQuantity,
                                        setToken,
                                      ),
                                    );

                                    if (relativeAmount == "higher") {
                                      const sendTokenBalanceBefore = await sendToken.balanceOf(
                                        setToken.address,
                                      );
                                      const additionalAmount = sendTokenBalanceBefore.div(10);
                                      await sendToken.transfer(setToken.address, additionalAmount);

                                      const sendTokenTotalPosition = await setToken.getTotalComponentRealUnits(
                                        sendToken.address,
                                      );
                                      const sendTokenBalance = await sendToken.balanceOf(
                                        setToken.address,
                                      );

                                      expect(
                                        sendTokenBalance.eq(
                                          sendTokenTotalPosition.add(additionalAmount),
                                        ),
                                      );
                                      const sendTokenPosition = await setToken.getDefaultPositionRealUnit(
                                        sendToken.address,
                                      );
                                      subjectSendQuantity = sendTokenPosition.add(
                                        sendTokenPosition.div(11),
                                      );
                                    }
                                    if (relativeAmount == "equal") {
                                      subjectSendQuantity = sendTokenPosition;
                                    }
                                    if (relativeAmount == "less") {
                                      subjectSendQuantity = sendTokenPosition.div(2);
                                    }

                                    if (functionName == "mintFCashForFixedToken") {
                                      await notionalV2Mock.setFCashEstimation(
                                        await convertPositionToNotional(
                                          subjectMinReceiveQuantity,
                                          setToken,
                                        ),
                                      );
                                    }
                                    if (functionName == "redeemFCashForFixedToken") {
                                      const sendQuantityTotal = await convertPositionToNotional(
                                        subjectSendQuantity,
                                        setToken,
                                      );
                                      await notionalV2Mock.setFCashEstimation(sendQuantityTotal);
                                    }
                                  });

                                  if (relativeAmount == "higher") {
                                    it("should revert", async () => {
                                      const revertReason =
                                        tradeDirection == "buying"
                                          ? "Insufficient sendToken position"
                                          : "Insufficient fCash position";
                                      await expect(subject()).to.be.revertedWith(revertReason);
                                    });
                                  } else {
                                    if (functionName == "mintFixedFCashForToken") {
                                      describe("When fCash amount exceeds max uint88", () => {
                                        beforeEach(async () => {
                                          const fCashNotional = BigNumber.from(2).pow(89);
                                          subjectMinReceiveQuantity = await convertNotionalToPosition(
                                            fCashNotional,
                                            setToken,
                                          );
                                          subjectSendQuantity = subjectSendQuantity.sub(1);
                                        });
                                        it("should revert", async () => {
                                          await expect(subject()).to.be.revertedWith(
                                            "Uint88 downcast: overflow",
                                          );
                                        });
                                      });
                                    }

                                    if (functionName == "redeemFCashForFixedToken") {
                                      describe("When estimated fcash amount exceeds specified max limit", () => {
                                        beforeEach(async () => {
                                          subjectSendQuantity = subjectSendQuantity.sub(1);
                                        });
                                        it("should revert", async () => {
                                          await expect(subject()).to.be.revertedWith(
                                            "Excessive redeem amount",
                                          );
                                        });
                                      });
                                    }

                                    if (functionName == "mintFCashForFixedToken") {
                                      describe("When estimated fcash amount is lower then specified min value", () => {
                                        beforeEach(async () => {
                                          subjectMinReceiveQuantity = subjectMinReceiveQuantity.add(
                                            1,
                                          );
                                        });
                                        it("should revert", async () => {
                                          await expect(subject()).to.be.revertedWith(
                                            "Insufficient mint amount",
                                          );
                                        });
                                      });
                                    }
                                    if (tradeDirection == "buying") {
                                      describe("When fCash wrapper uses less than maximum allowed amount", () => {
                                        beforeEach(async () => {
                                          await wrappedfCashMock.setMintTokenSpent(100);
                                        });
                                        afterEach(async () => {
                                          await wrappedfCashMock.setMintTokenSpent(0);
                                        });
                                        it("Should leave no left-over allowance", async () => {
                                          await subject();
                                          const allowance = await sendToken.allowance(
                                            setToken.address,
                                            wrappedfCashMock.address,
                                          );
                                          expect(allowance).to.eq(0);
                                        });
                                      });

                                      it("setToken should receive receiver token", async () => {
                                        const receiveTokenBalanceBefore = await receiveToken.balanceOf(
                                          setToken.address,
                                        );
                                        await subject();
                                        const receiveTokenBalanceAfter = await receiveToken.balanceOf(
                                          setToken.address,
                                        );
                                        expect(
                                          receiveTokenBalanceAfter.sub(receiveTokenBalanceBefore),
                                        ).to.be.gte(subjectMinReceiveQuantity);
                                      });
                                      describe("When sendToken is neither underlying nor asset token", () => {
                                        beforeEach(async () => {
                                          subjectSendToken = ethers.constants.AddressZero;
                                          await setToken
                                            .connect(owner.wallet)
                                            .addComponent(subjectSendToken);
                                        });
                                        it("should revert", async () => {
                                          await expect(subject()).to.be.revertedWith(
                                            "Insufficient sendToken position",
                                          );
                                        });
                                      });

                                      describe("When receiveAmount is 0", () => {
                                        beforeEach(async () => {
                                          subjectMinReceiveQuantity = BigNumber.from(0);
                                        });
                                        it("should not revert", async () => {
                                          await subject();
                                        });
                                      });

                                      if (relativeAmount == "less") {
                                        describe(`when too much ${tokenType} is spent`, () => {
                                          beforeEach(async () => {
                                            const oldSubjectSendQuantity = subjectSendQuantity;

                                            const funder = await deployer.mocks.deployForceFunderMock();
                                            await funder.fund(setToken.address, {
                                              value: ether(10),
                                            }); // Gas money

                                            await network.provider.request({
                                              method: "hardhat_impersonateAccount",
                                              params: [setToken.address],
                                            });
                                            const setTokenSigner = await ethers.getSigner(
                                              setToken.address,
                                            );
                                            await sendToken
                                              .connect(setTokenSigner)
                                              .approve(
                                                wrappedfCashMock.address,
                                                ethers.constants.MaxUint256,
                                              );

                                            const spendAmount = await convertPositionToNotional(
                                              oldSubjectSendQuantity.mul(5).div(4),
                                              setToken,
                                            );
                                            const allowance = await sendToken.allowance(
                                              setToken.address,
                                              wrappedfCashMock.address,
                                            );
                                            expect(allowance).to.be.gte(spendAmount);
                                            await wrappedfCashMock.setMintTokenSpent(spendAmount);

                                            subjectSendQuantity = oldSubjectSendQuantity;
                                          });
                                          it("should revert", async () => {
                                            await expect(subject()).to.be.revertedWith("Overspent");
                                          });
                                        });

                                        describe("when swap fails due to insufficient allowance", () => {
                                          beforeEach(async () => {
                                            await wrappedfCashMock.setMintTokenSpent(
                                              await convertPositionToNotional(
                                                subjectSendQuantity.mul(2),
                                                setToken,
                                              ),
                                            );
                                          });
                                          it("should revert", async () => {
                                            const revertMessage =
                                              tokenType == "assetToken"
                                                ? "WrappedfCashMock: Transfer failed"
                                                : underlyingTokenName == "dai"
                                                  ? "ERC20: transfer amount exceeds allowance"
                                                  : "Address: low-level call with value failed";
                                            await expect(subject()).to.be.revertedWith(
                                              revertMessage,
                                            );
                                          });
                                        });
                                      }
                                    } else {
                                      describe("When wrappedFCash is not deployed for given parameters", () => {
                                        beforeEach(async () => {
                                          subjectCurrencyId = 10;
                                        });
                                        it("should revert", async () => {
                                          await expect(subject()).to.be.revertedWith(
                                            "WrappedfCash not deployed for given parameters",
                                          );
                                        });
                                      });

                                      describe("When receiveToken is neither underlying nor asset token", () => {
                                        beforeEach(async () => {
                                          subjectReceiveToken = ethers.constants.AddressZero;
                                        });
                                        it("should revert", async () => {
                                          await expect(subject()).to.be.revertedWith(
                                            "Token is neither asset nor underlying token",
                                          );
                                        });
                                      });

                                      describe("When sendAmount is 0", () => {
                                        beforeEach(async () => {
                                          subjectSendQuantity = BigNumber.from(0);
                                          await notionalV2Mock.setFCashEstimation(0);
                                        });
                                        it("should not revert", async () => {
                                          await subject();
                                        });
                                      });

                                      describe(`when too little ${tokenType} is returned`, () => {
                                        beforeEach(async () => {
                                          await wrappedfCashMock.setRedeemTokenReturned(
                                            subjectMinReceiveQuantity.div(2),
                                          );
                                        });
                                        afterEach(async () => {
                                          await wrappedfCashMock.setRedeemTokenReturned(0);
                                        });
                                        it("should revert", async () => {
                                          await expect(subject()).to.be.revertedWith(
                                            "Not enough received amount",
                                          );
                                        });
                                      });
                                    }
                                    it("setToken should receive receiver token", async () => {
                                      const receiveTokenBalanceBefore = await receiveToken.balanceOf(
                                        setToken.address,
                                      );
                                      await subject();
                                      const receiveTokenBalanceAfter = await receiveToken.balanceOf(
                                        setToken.address,
                                      );
                                      expect(
                                        receiveTokenBalanceAfter.sub(receiveTokenBalanceBefore),
                                      ).to.be.gte(subjectMinReceiveQuantity);
                                    });

                                    it("setTokens sendToken balance should be adjusted accordingly", async () => {
                                      const sendTokenBalanceBefore = await sendToken.balanceOf(
                                        setToken.address,
                                      );
                                      await subject();
                                      const sendTokenBalanceAfter = await sendToken.balanceOf(
                                        setToken.address,
                                      );
                                      if (tradeDirection == "selling") {
                                        expect(
                                          sendTokenBalanceBefore.sub(sendTokenBalanceAfter),
                                        ).to.eq(
                                          await convertPositionToNotional(
                                            subjectSendQuantity,
                                            setToken,
                                          ),
                                        );
                                      } else {
                                        expect(
                                          sendTokenBalanceBefore.sub(sendTokenBalanceAfter),
                                        ).to.be.lte(
                                          await convertPositionToNotional(
                                            subjectSendQuantity,
                                            setToken,
                                          ),
                                        );
                                      }
                                    });

                                    if (relativeAmount == "less") {
                                      it("should not revert when executing trade twice", async () => {
                                        await subject();
                                        await subject();
                                      });
                                    }

                                    it("should return spent / received amount of non-fcash-token", async () => {
                                      const otherTokenBalanceBefore = await otherToken.balanceOf(
                                        setToken.address,
                                      );
                                      const result = await subjectCall();
                                      await subject();
                                      const otherTokenBalanceAfter = await otherToken.balanceOf(
                                        setToken.address,
                                      );

                                      let expectedResult;
                                      if (tradeDirection == "selling") {
                                        expectedResult = otherTokenBalanceAfter.sub(
                                          otherTokenBalanceBefore,
                                        );
                                      } else {
                                        expectedResult = otherTokenBalanceBefore.sub(
                                          otherTokenBalanceAfter,
                                        );
                                      }

                                      expect(result).to.eq(expectedResult);
                                    });

                                    it("should adjust the components position of the receiveToken correctly", async () => {
                                      const positionBefore = await setToken.getDefaultPositionRealUnit(
                                        receiveToken.address,
                                      );
                                      const tradeAmount = await subjectCall();
                                      await subject();
                                      const positionAfter = await setToken.getDefaultPositionRealUnit(
                                        receiveToken.address,
                                      );

                                      const positionChange = positionAfter.sub(positionBefore);

                                      let expectedPositionChange;
                                      if (tradeDirection == "selling") {
                                        expectedPositionChange = await convertNotionalToPosition(
                                          tradeAmount,
                                          setToken,
                                        );
                                      } else {
                                        expectedPositionChange = subjectMinReceiveQuantity;
                                      }

                                      expect(expectedPositionChange).to.eq(positionChange);
                                    });

                                    it("should adjust the components position of the sendToken correctly", async () => {
                                      const positionBefore = await setToken.getDefaultPositionRealUnit(
                                        sendToken.address,
                                      );
                                      const tradeAmount = await subjectCall();
                                      const expectedPositionChange =
                                        tradeDirection == "selling"
                                          ? subjectSendQuantity
                                          : await convertNotionalToPosition(tradeAmount, setToken);

                                      await subject();
                                      const positionAfter = await setToken.getDefaultPositionRealUnit(
                                        sendToken.address,
                                      );
                                      const positionChange = positionBefore.sub(positionAfter);

                                      expect(positionChange).to.eq(expectedPositionChange);
                                    });
                                  }
                                });
                              });
                            });
                          });
                        });
                      });
                    });
                  });
                  describe("#moduleIssue/RedeemHook", () => {
                    let subjectSetToken: string;
                    let subjectReceiver: string;
                    let subjectAmount: BigNumber;
                    let caller: SignerWithAddress;
                    beforeEach(() => {
                      subjectSetToken = setToken.address;
                      subjectAmount = ethers.utils.parseEther("1");
                      caller = owner.wallet;
                      subjectReceiver = caller.address;
                    });
                    describe("When wrappedFCash is a registered component", () => {
                      beforeEach(async () => {
                        const fCashAmount = ethers.utils.parseUnits("10", 8);
                        await wrappedfCashMock.mintViaUnderlying(
                          0,
                          fCashAmount,
                          setToken.address,
                          0,
                        );
                        const setTokenFCashBalance = await wrappedfCashMock.balanceOf(
                          setToken.address,
                        );

                        await setup.controller.connect(owner.wallet).addModule(owner.address);
                        await setToken.connect(manager.wallet).addModule(owner.address);
                        await setToken.connect(owner.wallet).initializeModule();
                        await setToken.connect(owner.wallet).addComponent(wrappedfCashMock.address);

                        const wrappedfCashMockBalanceAfter = await wrappedfCashMock.balanceOf(
                          setToken.address,
                        );
                        expect(await setToken.isComponent(wrappedfCashMock.address)).to.be.true;
                        expect(wrappedfCashMockBalanceAfter).to.be.gte(fCashAmount);

                        const fCashPositionToSet = await convertNotionalToPosition(
                          setTokenFCashBalance,
                          setToken,
                        );

                        await setToken
                          .connect(owner.wallet)
                          .editDefaultPositionUnit(wrappedfCashMock.address, fCashPositionToSet);
                        const wrappedfCashMockPositionAfter = await setToken.getTotalComponentRealUnits(
                          wrappedfCashMock.address,
                        );
                        // Make sure set token was added to set
                        expect(wrappedfCashMockPositionAfter).to.be.gt(0);
                      });
                      ["assetToken", "underlyingToken"].forEach(redeemToken => {
                        describe(`when redeeming to ${redeemToken}`, () => {
                          let outputToken: IERC20;
                          beforeEach(async () => {
                            const toUnderlying = redeemToken == "underlyingToken";
                            await notionalTradeModule
                              .connect(manager.wallet)
                              .setRedeemToUnderlying(subjectSetToken, toUnderlying);
                            outputToken =
                              toUnderlying ? underlyingToken : assetToken;
                          });
                          ["issue", "redeem", "removeModule", "manualTrigger"].forEach(
                            triggerAction => {
                              describe(`When hook is triggered by ${triggerAction}`, () => {
                                beforeEach(async () => {
                                  const fCashAmount = ethers.utils.parseUnits("20", 8);
                                  const underlyingTokenAmount = ethers.utils.parseEther("21");

                                  await assetToken.connect(owner.wallet).mint(ether(1));
                                  const assetTokenBalance = await assetToken.balanceOf(
                                    owner.address,
                                  );
                                  await assetToken
                                    .connect(owner.wallet)
                                    .transfer(wrappedfCashMock.address, assetTokenBalance);

                                  const redemptionAssetAmount = assetTokenBalance.div(2);
                                  await wrappedfCashMock.setRedeemTokenReturned(
                                    redemptionAssetAmount,
                                  );

                                  if (triggerAction == "redeem") {
                                    await underlyingToken
                                      .connect(owner.wallet)
                                      .approve(
                                        wrappedfCashMock.address,
                                        ethers.constants.MaxUint256,
                                      );
                                    await mintWrappedFCash(
                                      owner.wallet,
                                      underlyingToken,
                                      underlyingTokenAmount,
                                      fCashAmount,
                                      assetToken as any,
                                      wrappedfCashMock as any,
                                      true,
                                    );
                                    await wrappedfCashMock
                                      .connect(owner.wallet)
                                      .approve(
                                        debtIssuanceModule.address,
                                        ethers.constants.MaxUint256,
                                      );
                                    await debtIssuanceModule
                                      .connect(owner.wallet)
                                      .issue(subjectSetToken, subjectAmount, caller.address);
                                    await setToken
                                      .connect(caller)
                                      .approve(debtIssuanceModule.address, subjectAmount);
                                  } else if (triggerAction == "issue") {
                                    await underlyingToken.transfer(
                                      caller.address,
                                      underlyingTokenAmount,
                                    );

                                    if (redeemToken == "underlyingToken") {
                                      await underlyingToken
                                        .connect(caller)
                                        .approve(
                                          debtIssuanceModule.address,
                                          ethers.constants.MaxUint256,
                                        );
                                    } else {
                                      await underlyingToken
                                        .connect(caller)
                                        .approve(assetToken.address, ethers.constants.MaxUint256);
                                      await assetToken.connect(caller).mint(underlyingTokenAmount);
                                      await assetToken
                                        .connect(caller)
                                        .approve(
                                          debtIssuanceModule.address,
                                          ethers.constants.MaxUint256,
                                        );
                                    }
                                  }
                                });

                                const subject = () => {
                                  if (triggerAction == "issue") {
                                    return debtIssuanceModule
                                      .connect(caller)
                                      .issue(subjectSetToken, subjectAmount, subjectReceiver);
                                  } else if (triggerAction == "redeem") {
                                    return debtIssuanceModule
                                      .connect(caller)
                                      .redeem(subjectSetToken, subjectAmount, subjectReceiver);
                                  } else if (triggerAction == "removeModule") {
                                    return setToken
                                      .connect(manager.wallet)
                                      .removeModule(notionalTradeModule.address);
                                  } else {
                                    return notionalTradeModule
                                      .connect(caller)
                                      .redeemMaturedPositions(subjectSetToken);
                                  }
                                };

                                describe("When component has not matured yet", () => {
                                  beforeEach(async () => {
                                    if (triggerAction == "issue") {
                                      const underlyingTokenAmount = ethers.utils.parseEther("2.1");
                                      const fCashAmount = ethers.utils.parseUnits("2", 8);
                                      await mintWrappedFCash(
                                        caller,
                                        underlyingToken,
                                        underlyingTokenAmount,
                                        fCashAmount,
                                        assetToken as any,
                                        wrappedfCashMock as any,
                                        true,
                                      );
                                      await wrappedfCashMock
                                        .connect(caller)
                                        .approve(
                                          debtIssuanceModule.address,
                                          ethers.constants.MaxUint256,
                                        );
                                    }
                                    expect(await wrappedfCashMock.hasMatured()).to.be.false;
                                  });
                                  it("fCash position remains the same", async () => {
                                    const positionBefore = await setToken.getDefaultPositionRealUnit(
                                      wrappedfCashMock.address,
                                    );
                                    await subject();
                                    const positionAfter = await setToken.getDefaultPositionRealUnit(
                                      wrappedfCashMock.address,
                                    );
                                    expect(positionAfter).to.eq(positionBefore);
                                  });
                                });

                                describe("When component has matured", () => {
                                  beforeEach(async () => {
                                    await wrappedfCashMock.setMatured(true);
                                  });

                                  if (triggerAction != "manualTrigger") {
                                    describe("when automatic redemption has been disabled", () => {
                                      beforeEach(async () => {
                                        if (triggerAction == "issue") {
                                          const underlyingTokenAmount = ethers.utils.parseEther(
                                            "2.1",
                                          );
                                          const fCashAmount = ethers.utils.parseUnits("2", 8);
                                          await mintWrappedFCash(
                                            caller,
                                            underlyingToken,
                                            underlyingTokenAmount,
                                            fCashAmount,
                                            assetToken as any,
                                            wrappedfCashMock as any,
                                            true,
                                          );
                                          await wrappedfCashMock
                                            .connect(caller)
                                            .approve(
                                              debtIssuanceModule.address,
                                              ethers.constants.MaxUint256,
                                            );
                                        }
                                        await notionalTradeModule
                                          .connect(manager.wallet)
                                          .updateRedemptionHookDisabled(setToken.address, true);
                                      });
                                      it("fCash position remains the same", async () => {
                                        const positionBefore = await setToken.getDefaultPositionRealUnit(
                                          wrappedfCashMock.address,
                                        );
                                        await subject();
                                        const positionAfter = await setToken.getDefaultPositionRealUnit(
                                          wrappedfCashMock.address,
                                        );
                                        expect(positionAfter).to.eq(positionBefore);
                                      });
                                    });
                                  }

                                  if (["issue", "redeem"].includes(triggerAction)) {
                                    it(`should adjust ${redeemToken} balance correctly`, async () => {
                                      const outputTokenBalanceBefore = await outputToken.balanceOf(
                                        caller.address,
                                      );
                                      await subject();
                                      const outputTokenBalanceAfter = await outputToken.balanceOf(
                                        caller.address,
                                      );
                                      const amountAssetTokenTransfered =
                                        triggerAction == "redeem"
                                          ? outputTokenBalanceAfter.sub(outputTokenBalanceBefore)
                                          : outputTokenBalanceBefore.sub(outputTokenBalanceAfter);

                                      expect(amountAssetTokenTransfered).to.be.gt(0);
                                    });

                                    it("should issue correct amount of set tokens", async () => {
                                      const setTokenBalanceBefore = await setToken.balanceOf(
                                        caller.address,
                                      );
                                      await subject();
                                      const setTokenBalanceAfter = await setToken.balanceOf(
                                        caller.address,
                                      );
                                      const expectedBalanceChange =
                                        triggerAction == "issue"
                                          ? subjectAmount
                                          : subjectAmount.mul(-1);
                                      expect(setTokenBalanceAfter.sub(setTokenBalanceBefore)).to.eq(
                                        expectedBalanceChange,
                                      );
                                    });
                                  }

                                  it("Removes wrappedFCash from component list", async () => {
                                    expect(await setToken.isComponent(wrappedfCashMock.address)).to
                                      .be.true;
                                    await subject();
                                    expect(await setToken.isComponent(wrappedfCashMock.address)).to
                                      .be.false;
                                  });

                                  it("Removes wrappedFCash from the list of registered fCashComponents", async () => {
                                    await subject();
                                    const fCashComponents = await notionalTradeModule.getFCashComponents(
                                      subjectSetToken,
                                    );
                                    expect(fCashComponents).to.not.include(
                                      wrappedfCashMock.address,
                                    );
                                  });

                                  it(`Adds ${redeemToken} token to component list`, async () => {
                                    expect(await setToken.isComponent(outputToken.address)).to.be
                                      .false;
                                    await subject();
                                    expect(await setToken.isComponent(outputToken.address)).to.be
                                      .true;
                                  });

                                  it("Afterwards setToken should have no fCash balance anymore", async () => {
                                    const balanceBefore = await wrappedfCashMock.balanceOf(
                                      subjectSetToken,
                                    );
                                    expect(balanceBefore).to.be.gt(0);
                                    await subject();
                                    const balanceAfter = await wrappedfCashMock.balanceOf(
                                      subjectSetToken,
                                    );
                                    expect(balanceAfter).to.eq(0);
                                  });

                                  it(`Afterwards setToken should have received ${redeemToken} token`, async () => {
                                    const balanceBefore = await outputToken.balanceOf(
                                      subjectSetToken,
                                    );
                                    await subject();
                                    const balanceAfter = await outputToken.balanceOf(
                                      subjectSetToken,
                                    );
                                    expect(balanceAfter.sub(balanceBefore)).to.be.gt(0);
                                  });

                                  it(`Afterwards setToken should have positive ${redeemToken} position`, async () => {
                                    const positionBefore = await setToken.getDefaultPositionRealUnit(
                                      outputToken.address,
                                    );
                                    await subject();
                                    const positionAfter = await setToken.getDefaultPositionRealUnit(
                                      outputToken.address,
                                    );
                                    expect(positionAfter.sub(positionBefore)).to.be.gt(0);
                                  });

                                  describe("When positions have been redeemed already", () => {
                                    beforeEach(async () => {
                                      await notionalTradeModule.redeemMaturedPositions(
                                        setToken.address,
                                      );
                                    });
                                    it("should not revert", async () => {
                                      await subject();
                                    });
                                  });

                                  describe("When positions have been redeemed already", () => {
                                    beforeEach(async () => {
                                      await notionalTradeModule.redeemMaturedPositions(
                                        setToken.address,
                                      );
                                    });
                                    it("should not revert", async () => {
                                      await subject();
                                    });
                                  });

                                  if (triggerAction == "manualTrigger") {
                                    [
                                      "wrong currencyId",
                                      "wrong maturity",
                                      "reverted getDecodedID",
                                      "reverted computeAddress",
                                      "negative unit",
                                    ].forEach(reason => {
                                      describe(`When the wrappedFCash position is not recognized as such because of ${reason}`, () => {
                                        beforeEach(async () => {
                                          if (reason == "wrong currencyId") {
                                            await wrappedfCashMock.initialize(420, maturity);
                                          } else if (reason == "wrong maturity") {
                                            await wrappedfCashMock.initialize(currencyId, 420);
                                          } else if (reason == "reverted getDecodedID") {
                                            await wrappedfCashMock.setRevertDecodedID(true);
                                          } else if (reason == "reverted computeAddress") {
                                            await wrappedfCashFactoryMock.setRevertComputeAddress(
                                              true,
                                            );
                                          } else if (reason == "negative unit") {
                                            await setToken
                                              .connect(owner.wallet)
                                              .editDefaultPositionUnit(
                                                wrappedfCashMock.address,
                                                -420,
                                              );
                                            const externalPositionModule = await getRandomAddress();
                                            await setToken
                                              .connect(owner.wallet)
                                              .addExternalPositionModule(
                                                wrappedfCashMock.address,
                                                externalPositionModule,
                                              );
                                            // Have to add it back in as an external position to get a negative unit
                                            await setToken
                                              .connect(owner.wallet)
                                              .editExternalPositionUnit(
                                                wrappedfCashMock.address,
                                                externalPositionModule,
                                                -420,
                                              );
                                          }
                                        });
                                        it("fCash position remains the same", async () => {
                                          const positionBefore = await setToken.getDefaultPositionRealUnit(
                                            wrappedfCashMock.address,
                                          );
                                          await subject();
                                          const positionAfter = await setToken.getDefaultPositionRealUnit(
                                            wrappedfCashMock.address,
                                          );
                                          expect(positionAfter).to.eq(positionBefore);
                                        });
                                      });
                                    });

                                    describe("When setToken contains an additional position that is not a smart contract", () => {
                                      beforeEach(async () => {
                                        const nonContractComponent = await getRandomAddress();
                                        await setToken
                                          .connect(owner.wallet)
                                          .addComponent(nonContractComponent);
                                        await setToken
                                          .connect(owner.wallet)
                                          .editDefaultPositionUnit(nonContractComponent, 420);
                                      });
                                      it(`Afterwards setToken should have received ${redeemToken} token`, async () => {
                                        const balanceBefore = await outputToken.balanceOf(
                                          subjectSetToken,
                                        );
                                        await subject();
                                        const balanceAfter = await outputToken.balanceOf(
                                          subjectSetToken,
                                        );
                                        expect(balanceAfter.sub(balanceBefore)).to.be.gt(0);
                                      });

                                      it(`Afterwards setToken should have positive ${redeemToken} position`, async () => {
                                        const positionBefore = await setToken.getDefaultPositionRealUnit(
                                          outputToken.address,
                                        );
                                        await subject();
                                        const positionAfter = await setToken.getDefaultPositionRealUnit(
                                          outputToken.address,
                                        );
                                        expect(positionAfter.sub(positionBefore)).to.be.gt(0);
                                      });
                                    });
                                  }
                                });
                              });
                            },
                          );
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});
