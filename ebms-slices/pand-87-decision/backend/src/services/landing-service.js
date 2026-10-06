'use strict';

const { DOMAIN_LABELS } = require('../lib/domain');

// 登录后的默认落地视图。落地口径归 F15（PAND-93）：决策者 → REPORT，管理责任人 → 本责任域。
// 本切片交付的是 F9 Decision 视图，因此 route 指向本切片实际装载的 Decision 视图，
// view 仍保留 F15 的角色口径，供 PAND-93 切片统一裁决。
function resolveLanding(identity) {
  const roles = identity.roles || [];
  const isDecisionMaker = roles.includes('decision_maker');
  const isDomainOwner = roles.includes('domain_owner');

  if (isDecisionMaker) {
    return {
      view: 'decision',
      route: '/decisions',
      reportRoute: '/reports',
      scope: { mode: 'all', label: '全企业口径' },
      availableViews: ['decision', 'report', 'todo', 'evidence'],
    };
  }

  if (isDomainOwner) {
    const domains = (identity.scope && identity.scope.domains) || [];
    return {
      view: 'decision',
      route: '/decisions',
      reportRoute: '/reports',
      scope: {
        mode: 'domain',
        domains,
        label: domains.map((d) => DOMAIN_LABELS[d] || d).join('、') || '未配置责任域',
      },
      availableViews: ['decision', 'report', 'todo'],
    };
  }

  return {
    view: null,
    route: null,
    reportRoute: null,
    scope: { mode: 'none', label: '' },
    availableViews: [],
    notice: '当前账号未配置任何角色，无法进入 EBMS 主体功能，请联系管理员。',
  };
}

module.exports = { resolveLanding };
