/**
 * EBMS 数据接入层 —— Provider 工厂。
 *
 * 业务模块统一通过 `const provider = require('./data-provider')` 取数，
 * 不感知数据来源是本地表还是 EDP。
 *
 * 切换：环境变量 EBMS_DATA_PROVIDER=local（默认）| edp
 * 约定：所有取数方法统一用 `await provider.getXxx(...)` 调用
 *       （LocalProvider 为同步值，EdpProvider 为 Promise，await 两者均兼容）。
 */
const PROVIDER = (process.env.EBMS_DATA_PROVIDER || 'local').toLowerCase();

function getProvider() {
  if (PROVIDER === 'edp') return require('./edp-provider');
  return require('./local-provider');
}

module.exports = getProvider();
module.exports.getProvider = getProvider;
module.exports.PROVIDER = PROVIDER;
module.exports.contracts = require('./contracts');
