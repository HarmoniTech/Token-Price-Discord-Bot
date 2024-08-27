const mongoose = require('mongoose');

const PoolSchema = new mongoose.Schema({
  poolId: { type: String, required: true, unique: true },
  dexId: { type: String, required: true },
  url: { type: String },
  poolPair: { type: String },
  priceNative: { type: Number },
  priceUsd: { type: Number },
  liquidity: { type: Number },
  supply: { type: Number },
  lastSeen: { type: Date },
});

const PoolModel = mongoose.model("pool", PoolSchema);

module.exports = PoolModel;