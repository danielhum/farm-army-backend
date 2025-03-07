"use strict";

const _ = require("lodash");
const fs = require("fs");
const path = require("path");
const Utils = require("../../services").Utils;
const Web3EthContract = require("web3-eth-contract");

const b3c9 = require('./abi/0xb3c96d3c3d643c2318e4cdd0a9a48af53131f5f4.json');

module.exports = class pancakebunny {
  constructor(cache, priceOracle, tokenCollector) {
    this.cache = cache;
    this.priceOracle = priceOracle;
    this.tokenCollector = tokenCollector
  }

  /**
   * "new boost" vaults are hard coded :(
   */
  static BUNNY_CHEF_ADDRESSES = [
    '0xb037581cF0cE10b04C4735443d95e0C93db5d940',
    '0x69FF781Cf86d42af9Bf93c06B8bE0F16a2905cBC'
  ]

  static ABI = JSON.parse(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "abi/0xe375a12a556e954ccd48c0e0d3943f160d45ac2e.json"
      ),
      "utf8"
    )
  )

  static BUNNY_CHEF_ABI = JSON.parse(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "abi/bunnyChef.json"
      ),
      "utf8"
    )
  )

  async getLbAddresses() {
    const response = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "farms.json"), "utf8")
    );

    const lpAddresses = [];
    for (const key of Object.keys(response)) {
      const farm = response[key];

      // lpAddress
      if (farm.token && key.match(/([\w]{0,4})-([\w]{0,4})\s*/g)) {
        lpAddresses.push(farm.token);
      }
    }

    return _.uniq(lpAddresses);
  }

  async getAddressFarms(address) {
    const cacheItem = this.cache.get(`getAddressFarms-pancakebunny-${address}`);
    if (cacheItem) {
      return cacheItem;
    }

    const abi = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "abi/0xe375a12a556e954ccd48c0e0d3943f160d45ac2e.json"
        ),
        "utf8"
      )
    );

    const farms = await this.getFarms();

    const tokenCalls = farms.map(myPool => {
      return {
        reference: myPool.id.toString(),
        contractAddress: "0xe375a12a556e954ccd48c0e0d3943f160d45ac2e",
        abi: abi,
        calls: [
          {
            reference: "infoOfPool",
            method: "infoOfPool",
            parameters: [myPool.raw.address, address]
          }
        ]
      };
    });

    const calls = await Utils.multiCallRpc(tokenCalls);

    const result = calls
      .filter(
        v =>
          v.infoOfPool &&
          v.infoOfPool.balance &&
          !v.infoOfPool.balance.isZero(0)
      )
      .map(v => v.id);

    this.cache.put(`getAddressFarms-pancakebunny-${address}`, result, {
      ttl: 300 * 1000
    });

    return result;
  }

  async getFarms(refresh = false) {
    const cacheKey = "getFarms-pancakebunny";

    if (!refresh) {
      const cacheItem = this.cache.get(cacheKey);
      if (cacheItem) {
        return cacheItem;
      }
    }

    const response = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "farms.json"), "utf8")
    );

    const [prices, overall] = await Promise.all([
      this.getTokenPrices(),
      this.getOverall()
    ]);

    const farms = [];

    for (const key of Object.keys(response)) {
      const farm = response[key];

      if (farm.closed === true) {
        continue;
      }

      farm.id = key;

      let tokenSymbol = key.toLowerCase()
        .replace('boost', '')
        .replace('flip', '')
        .replace('cake maximizer', '')
        .replace('maximizer', '')
        .replace('flip', '')
        .replace('v2', '')
        .replace(/\s/g, '')
        .trim();

      if (farm.token) {
        const lpSymbol = this.tokenCollector.getSymbolByAddress(farm.token);
        if (lpSymbol) {
          tokenSymbol = lpSymbol;
        }
      }

      const items = {
        id: `pancakebunny_${key.toLowerCase().replace(/\s/g, '-')}`,
        name: key,
        token: tokenSymbol,
        platform: farm.liquidity ? "pancake" : "pancakebunny",
        raw: Object.freeze(farm),
        provider: "pancakebunny",
        link: `https://pancakebunny.finance/farm/${encodeURI(key)}`,
        has_details: true,
        extra: {}
      };

      // lpAddress
      if (key.match(/([\w]{0,4})-([\w]{0,4})\s*/g)) {
        items.extra.lpAddress = farm.token;
      }

      if (farm.address) {
        items.extra.transactionAddress = farm.address;
      }

      if (farm.token) {
        items.extra.transactionToken = farm.token;
      }

      if (prices[key]) {
        items.extra.tokenPrice = prices[key];
      }

      const notes = [];
      if (farm.summary) {
        notes.push(farm.summary);
      }

      if (farm.description) {
        notes.push(farm.description);
      }

      const finalNotes = _.uniq(
        notes
          .map(b => b.replace(/<\/?[^>]+(>|$)/g, "").trim())
          .filter(b => b.length > 0)
      );

      if (finalNotes.length > 0) {
        items.notes = finalNotes;
      }

      if (overall[key] && overall[key].tvl) {
        items.tvl = {
          usd: overall[key].tvl / 1e18
        };
      }

      if (overall[key] && overall[key].apyOfPool) {
        let apy = 0;

        const [apyPool, apyBunny] = Object.values(overall[key].apyOfPool);

        if (apyPool > 0) {
          apy += apyPool / 1e16;
        }

        if (apyBunny > 0) {
          apy += apyPool / 1e16;
        }

        if (apy > 0) {
          items.yield = {
            apy: apy
          };
        }
      }

      if (farm.earn) {
        const earn = farm.earn.toLowerCase().replace(/ /g, '');
        earn.split("+").filter(e => e.match(/^[\w-]{1,6}$/g)).forEach(e => {
          const token = e.trim();
          if (!items.earns) {
            items.earns = [];
          }

          items.earns.push(token);
        });
      }

      farms.push(Object.freeze(items));
    }

    this.cache.put(cacheKey, farms, { ttl: 1000 * 60 * 30 });

    console.log("pancakebunny updated");

    return farms;
  }

  async getTransactions(address, id) {
    const farm = (await this.getFarms()).find(f => f.id === id);
    if (!farm) {
      return {};
    }

    if (farm.extra.transactionAddress && farm.extra.transactionToken) {
      return Utils.getTransactions(
        farm.extra.transactionAddress,
        farm.extra.transactionToken,
        address
      );
    }

    return [];
  }

  async getYields(address) {
    const addressFarms = await this.getAddressFarms(address);
    if (addressFarms.length === 0) {
      return [];
    }

    return await this.getYieldsInner(address, addressFarms);
  }

  async getYieldsInner(address, addressFarms) {
    if (addressFarms.length === 0) {
      return [];
    }

    const farms = await this.getFarms();

    const abi = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "abi/0xe375a12a556e954ccd48c0e0d3943f160d45ac2e.json"
        ),
        "utf8"
      )
    );

    const bunnyPrice = this.priceOracle.findPrice("bunny");
    const cakePrice = this.priceOracle.findPrice("cake");
    const bnbPrice = this.priceOracle.findPrice("bnb");

    const infoOfPool = addressFarms
      .map(farmId => farms.find(f => f.id === farmId))
      .filter(farm => !pancakebunny.BUNNY_CHEF_ADDRESSES.includes(farm.raw.address))
      .map(myPool => {
        return {
          reference: myPool.id.toString(),
          contractAddress: "0xe375a12a556e954ccd48c0e0d3943f160d45ac2e",
          abi: abi,
          calls: [
            {
              reference: "infoOfPool",
              method: "infoOfPool",
              parameters: [myPool.raw.address, address]
            }
          ]
        };
      });

    const poolsOfAddresses = addressFarms
      .map(farmId => farms.find(f => f.id === farmId))
      .map(farm => farm.raw.address);

    const poolsOfCall = {
      reference: 'poolsOf',
      contractAddress: "0xb3c96d3c3d643c2318e4cdd0a9a48af53131f5f4",
      abi: b3c9,
      calls: [
        {
          reference: "poolsOf",
          method: "poolsOf",
          parameters: [address, poolsOfAddresses]
        }
      ]
    }

    const calls = await Utils.multiCallRpcIndex([...infoOfPool, poolsOfCall]);

    const poolsOf = {};
    if (calls.poolsOf && calls.poolsOf.poolsOf) {
      calls.poolsOf.poolsOf.forEach(p => {
        poolsOf[p.pool.toLowerCase()] = p;
      })
    }

    const results = [];

    for (const id of addressFarms) {
      const farm = farms.find(f => f.id === id);

      const result = {};

      result.farm = farm;

      let balance

      if (calls[farm.id] && calls[farm.id].infoOfPool && calls[farm.id].infoOfPool.balance && calls[farm.id].infoOfPool.balance.gt(0)) {
        balance = calls[farm.id].infoOfPool.balance.toString();
      }

      if (!balance && poolsOf[farm.raw.address.toLowerCase()]) {
        balance = poolsOf[farm.raw.address.toLowerCase()].balance.toString();
      }

      if (balance) {
        result.deposit = {
          symbol: "?",
          amount: balance / 1e18
        };

        let price = (farm.extra && farm.extra.tokenPrice) ? farm.extra.tokenPrice : undefined;

        if (!price && farm.raw.token) {
          price = this.priceOracle.getAddressPrice(farm.raw.token);
        }

        if (price) {
          result.deposit.usd = (result.deposit.amount * price) / 1e18;
        }
      }

      // dust
      if (result.deposit && result.deposit.usd && result.deposit.usd < 0.01) {
        continue;
      }

      let pendingUSD
      let pendingBNB
      let pendingBUNNY
      let pendingCAKE

      let info = undefined;

      // old ones
      if (calls[farm.id] && calls[farm.id].infoOfPool) {
        info = calls[farm.id].infoOfPool;

        const { pUSD, pBNB, pBUNNY, pCAKE } = info;

        pendingUSD = pUSD;
        pendingBNB = pBNB;
        pendingBUNNY = pBUNNY;
        pendingCAKE = pCAKE;
      }

      // ???
      if (poolsOf[farm.raw.address.toLowerCase()]) {
        info = poolsOf[farm.raw.address.toLowerCase()]

        const { pUSD, pBNB, pBUNNY, pCAKE } = info;

        if (pendingUSD && !pendingUSD.gt(0) > 0) {
          pendingUSD = pUSD;
        }

        if (pendingBNB && !pendingBNB.gt(0) > 0) {
          pendingBNB = pBNB;
        }

        if (pendingBUNNY && !pendingBUNNY.gt(0) > 0) {
          pendingBUNNY = pBUNNY;
        }

        if (pendingCAKE && !pendingCAKE.gt(0) > 0) {
          pendingCAKE = pCAKE;
        }
      }

      if (pendingUSD || pendingBNB || pendingBUNNY || pendingCAKE) {
        result.rewards = [];

        if (pendingBUNNY && pendingBUNNY.gt(0)) {
          const item = {
            symbol: "bunny",
            amount: pendingBUNNY.toString() / 1e18
          };

          if (bunnyPrice) {
            item.usd = item.amount * bunnyPrice;
          }

          result.rewards.push(item);
        }

        if (pendingBNB && pendingBNB.gt(0)) {
          const item = {
            symbol: "bnb",
            amount: pendingBNB.toString() / 1e18
          };

          if (bnbPrice) {
            item.usd = item.amount * bnbPrice;
          }

          result.rewards.push(item);
        }

        if (pendingCAKE && pendingCAKE.gt(0)) {
          const item = {
            symbol: "cake",
            amount: pendingCAKE.toString() / 1e18
          };

          if (cakePrice) {
            item.usd = item.amount * cakePrice;
          }

          result.rewards.push(item);
        }
      }

      results.push(result);
    }

    return results;
  }

  async getTokenPrices() {
    const farms = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "farms.json"), "utf8")
    );

    const abi = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "abi/0xe375a12a556e954ccd48c0e0d3943f160d45ac2e.json"
        ),
        "utf8"
      )
    );

    const token = new Web3EthContract(
      abi,
      "0xe375a12a556e954ccd48c0e0d3943f160d45ac2e"
    );

    const tokenCalls = [];
    for (const key of Object.keys(farms)) {
      const farm = farms[key];

      tokenCalls.push({
        valueOfAsset: token.methods.valueOfAsset(farm.token, (1e18).toString()),
        id: key
      });
    }

    const calls = await Utils.multiCall(tokenCalls);

    const tokenPrices = {};

    calls.forEach(c => {
      if (c.valueOfAsset[1]) {
        tokenPrices[c.id] = c.valueOfAsset[1];
      }
    });

    return tokenPrices;
  }

  async getOverall() {
    const farms = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "farms.json"), "utf8")
    );

    const tokenCalls = [];
    for (const key of Object.keys(farms)) {
      const farm = farms[key];

      if (farm.closed === true) {
        continue;
      }

      const token = new Web3EthContract(pancakebunny.ABI, "0xe375a12a556e954ccd48c0e0d3943f160d45ac2e");

      tokenCalls.push({
        apyOfPool: token.methods.apyOfPool(farm.address, 365),
        tvl: token.methods.tvlOfPool(farm.address),
        id: key
      });
    }

    try {
      return await Utils.multiCallIndexBy("id", tokenCalls);
    } catch (e) {
      console.log('pankebunny info fetch issue', e.message)
      return {}
    }
  }

  async getDetails(address, id) {
    const farm = (await this.getFarms()).find(f => f.id === id);
    if (!farm) {
      return {};
    }

    const [yieldFarms, transactions] = await Promise.all([
      this.getYieldsInner(address, [farm.id]),
      this.getTransactions(address, id)
    ]);

    const result = {};

    let lpTokens = [];
    if (yieldFarms[0]) {
      result.farm = yieldFarms[0];
      lpTokens = this.priceOracle.getLpSplits(farm, yieldFarms[0]);
    }

    if (transactions && transactions.length > 0) {
      result.transactions = transactions;
    }

    if (lpTokens && lpTokens.length > 0) {
      result.lpTokens = lpTokens;
    }

    const yieldDetails = Utils.findYieldForDetails(result);
    if (yieldDetails) {
      result.yield = yieldDetails;
    }

    return result;
  }
};
