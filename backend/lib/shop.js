// Server-side shop catalog: the server is the source of truth for item prices
// and effects. The client may display whatever it likes, but purchases are
// validated here — the price is NEVER taken from the request body, so a client
// can't buy a 200-coin item for 1 coin.
const ITEM_CATALOG = {
  freeze_block: { price: 200, name: '连胜冷冻块', icon: '🧊' },
  xp_boost_15: { price: 300, name: '经验药水 (15分钟)', icon: '🧪' },
  heart_pack: { price: 350, name: '红心补充包', icon: '💝' },
  streak_shield: { price: 150, name: '连胜护盾', icon: '🛡️' },
};

const BOOST_DURATION_MS = 15 * 60 * 1000;

// Apply an item's instant effect to the user's game state (returns updated state).
// Stock/counter items (freeze_block, streak_shield) just bump their counter;
// consumables (heart_pack, xp_boost_15) apply immediately.
function applyItemEffect(db, userId, itemId) {
  const state = db.getGameState(userId);
  if (itemId === 'heart_pack') {
    return db.updateGameState(userId, { hearts: state.max_hearts });
  }
  if (itemId === 'xp_boost_15') {
    const boostEnd = new Date(Date.now() + BOOST_DURATION_MS).toISOString();
    return db.updateGameState(userId, { xp_boost_multiplier: 2.0, xp_boost_until: boostEnd });
  }
  if (itemId === 'freeze_block') {
    return db.updateGameState(userId, { freeze_item_count: (state.freeze_item_count || 0) + 1 });
  }
  if (itemId === 'streak_shield') {
    return db.updateGameState(userId, { streak_shield_count: (state.streak_shield_count || 0) + 1 });
  }
  return state;
}

module.exports = { ITEM_CATALOG, applyItemEffect };
