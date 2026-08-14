import { useState } from 'react';
import { useGame } from '../context/GameContext';

const SHOP_ITEMS = [
  {
    id: 'freeze_block',
    name: '连胜冷冻块',
    icon: '🧊',
    description: '漏签一天不会断连胜',
    price: 200,
  },
  {
    id: 'xp_boost_15',
    name: '经验药水 (15分钟)',
    icon: '🧪',
    description: '15分钟内经验值2倍',
    price: 300,
  },
  {
    id: 'heart_pack',
    name: '红心补充包',
    icon: '💝',
    description: '立即恢复全部5颗红心',
    price: 350,
  },
  {
    id: 'streak_shield',
    name: '连胜护盾',
    icon: '🛡️',
    description: '错题不中断完美记录',
    price: 150,
  },
];

export default function Shop() {
  const { gameState, spendCoins, showToast } = useGame();
  const [purchasing, setPurchasing] = useState(null);

  const ownedCount = (itemId) => {
    if (itemId === 'freeze_block') return gameState?.freeze_item_count || 0;
    if (itemId === 'streak_shield') return gameState?.streak_shield_count || 0;
    if (itemId === 'xp_boost_15') {
      const active = gameState?.xp_boost_until && new Date(gameState.xp_boost_until) > new Date();
      return active ? 1 : 0; // shown as an active badge, not a stock count
    }
    return 0;
  };

  const handleBuy = async (item) => {
    if (gameState.coins < item.price) {
      showToast('🪙 金币不足！', 'danger');
      return;
    }
    setPurchasing(item.id);
    const result = await spendCoins(item.price, item.id); // server re-validates price
    if (result.error) {
      showToast(result.error, 'danger');
    } else {
      if (item.id === 'xp_boost_15') {
        showToast('🧪 已生效：15分钟双倍经验！', 'success');
      } else if (item.id === 'heart_pack') {
        showToast('💝 已恢复全部红心！', 'success');
      } else {
        showToast(`✅ 购买了 ${item.name}！`, 'success');
      }
    }
    setPurchasing(null);
  };

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>🛒 道具商店</h1>
        <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
          使用金币购买道具，提升学习体验
        </div>
      </div>

      <div className="shop-grid">
        {SHOP_ITEMS.map(item => (
          <div key={item.id} className="shop-item">
            <div className="shop-item-icon">{item.icon}</div>
            <div className="shop-item-name">{item.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
              {item.description}
            </div>
            <div className="shop-item-price">🪙 {item.price}</div>
            {ownedCount(item.id) > 0 && item.id !== 'xp_boost_15' && (
              <div style={{ fontSize: 12, color: '#FF6B35', marginBottom: 8, fontWeight: 700 }}>
                持有 ×{ownedCount(item.id)}
              </div>
            )}
            {item.id === 'xp_boost_15' && ownedCount(item.id) > 0 && (
              <div style={{ fontSize: 12, color: '#FF6B35', marginBottom: 8, fontWeight: 700 }}>
                ⚡ 双倍经验进行中
              </div>
            )}
            <button
              className="btn btn-primary btn-sm btn-block"
              onClick={() => handleBuy(item)}
              disabled={purchasing === item.id}
            >
              {purchasing === item.id ? '购买中...' : '购买'}
            </button>
          </div>
        ))}
      </div>

      {/* Coin display */}
      <div style={{
        marginTop: 24,
        padding: 16,
        background: 'linear-gradient(135deg, #FFD700, #FFA500)',
        borderRadius: 'var(--radius)',
        color: 'white',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 14, opacity: 0.9 }}>当前金币</div>
        <div style={{ fontSize: 32, fontWeight: 800 }}>🪙 {gameState?.coins || 0}</div>
        <div style={{ fontSize: 13, marginTop: 4 }}>
          完成课程和连胜签到获取更多金币
        </div>
      </div>
    </div>
  );
}
