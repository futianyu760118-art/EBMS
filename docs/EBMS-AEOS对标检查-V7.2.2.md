# EBMS × AEOS 对标检查与调整计划（V7.2.2）

> 基线：AEOS 仓库 `gitee.com/ningbohengjianguangdian/AEOS`，`origin/main` = `c199b17`（Phase 1 人员变动闭环与统一契约）
> 审查日期：2026-11-06
> 目标系统：`D:\EBMS企业经营管理系统`（EBMS / M03）

---

## 一、对标结论摘要

AEOS 已从 V7.2 推进到 **V7.2.2 Phase 1**，治理从「文档」落成「机器可校验的注册表 + 版本化契约 + 门禁」。EBMS 目前仅跟上「销售同步通道」和「M10 POMS」两项，以下 8 项尚未对齐：

| # | 差距 | 优先级 | 依赖 |
|---|---|---|---|
| 1 | 人员生命周期契约（端点/5 能力/EDP 分发）| P0 | M02 EDP |
| 2 | 财经结果契约（消费 M09 FinanceResult）| P1 | M09 FAC + M02 EDP |
| 3 | 契约包引入（8 套 `contracts/v1`）| P0 | 无 |
| 4 | 系统注册表接入（`registry/` + manifest + upstreamCommit）| P0 | 无 |
| 5 | DEH 执行闭环（DecisionCase→…→Evidence）| P1 | M01 + 差距 3 |
| 6 | 统一身份（Keycloak OIDC）| P1 | Keycloak 部署 |
| 7 | 专业操作面下沉（POS-GR-03）| P2 | 各专业中心 |
| 8 | Owner 指定与签批 | P2 | 组织动作 |

---

## 二、调整计划

### 阶段 P0（1–2 周，Phase 1 验收主线）

#### 差距 1：人员生命周期契约对齐

**目标**：EBMS 作为 adapter，按统一契约经 M02 EDP 接收 `person.offboarded` / `person.reinstated` 事件，实现 5 项能力。

**现状**：`POST /api/m01/personnel/offboard`，M01 直连 HMAC 签名推送，仅 `offboard`。

**行动**
- [ ] 1.1 引入契约 `person-lifecycle-event-v1` / `person-lifecycle-result-v1` 到 `contracts/aeos-v1/`
- [ ] 1.2 新增统一 adapter 端点 `POST /internal/aeos/person-lifecycle`（按 event schema 校验，`event_type ∈ {person.offboarded, person.reinstated}`）
- [ ] 1.3 在 `backend/lib/m01-personnel-sync.js` 扩展 5 能力：
  - `offboard`（已有：停用用户）
  - `reinstate`（恢复登录，仅恢复基本登录、权限留「待管理员确认」）
  - `hide`（隐藏在职名单、转入已离职查询）
  - `revoke`（撤销角色/权限/IM 会话）
  - `audit`（复用 `m01_personnel_sync_log` 全量留痕）
- [ ] 1.4 幂等：以 `idempotency_key` 判重（替代现有时间戳签名），重复事件返回 `skipped`
- [ ] 1.5 回执：按 `person-lifecycle-result-v1` 返回 `{event_id, target_system:"M03_EBMS", status: synced|skipped|failed, changed, received_at}`
- [ ] 1.6 兼容：保留 `/api/m01/personnel/offboard` 至 EDP 接通后下线

**交付物**：`backend/routes/m01.js` 改造、`backend/lib/m01-personnel-sync.js` 扩展、`contracts/aeos-v1/` 两契约、`scripts/person-lifecycle-regression.test.js`

**验收**：契约校验通过；`offboard`/`reinstate` 幂等重放不重复记账；无 `M02_EDP` 分发时端点 fail-closed。

---

#### 差距 3：契约包引入

**目标**：EBMS 使用 AEOS 统一版本化契约，不维护第二套全局 schema。

**行动**
- [ ] 3.1 引入 AEOS `contracts/v1/` 8 套 schema（`audit-event`、`business-event`、`finance-result`、`lead-intake`、`person-lifecycle-event`、`person-lifecycle-result`、`principal-context`、`system-manifest`）到 `contracts/aeos-v1/`
- [ ] 3.2 落地 `contracts/manifest.json`（SHA-256 指纹），禁止手改生成的消费副本
- [ ] 3.3 新增 `scripts/validate-aeos-contracts.js`（node 版，等价 AEOS `scripts/validate_contracts.py`）

**交付物**：`contracts/aeos-v1/*` + manifest + 校验脚本

**验收**：契约校验脚本通过；manifest 指纹与 schema 一致。

---

#### 差距 4：系统注册表接入

**目标**：EBMS 登记到 AEOS 系统注册表，记录 `aeos.upstreamCommit`。

**行动**
- [ ] 4.1 新增 `registry/system-manifests/M03-EBMS.yaml`（按 `system-manifest-v1` schema：`system_code=EBMS, module_id=M03, protocol=HTTPS, criticality=HIGH` 等）
- [ ] 4.2 配置 `aeos.upstreamCommit`（EBMS 当前 HEAD 对应 AEOS 基线），消除 registry 中「upstreamCommit 未配置」告警
- [ ] 4.3 回填 `person_lifecycle_endpoint=/internal/aeos/person-lifecycle`、`sync_capabilities` 到 manifest

**交付物**：`registry/` + `aeos.upstreamCommit` 配置

**验收**：AEOS `scripts/validate_registry.py` 对 M03 校验通过。

---

### 阶段 P1（1 个月内）

#### 差距 2：财经结果契约

**目标**：EBMS 只消费 M09 已 `VERIFIED` 的 FinanceResult，不再自算财务事实。

**行动**
- [ ] 2.1 引入 `finance-result-v1` 契约 + `fac-ebms-result` 映射到 `contracts/aeos-v1/` 与 `mappings/`
- [ ] 2.2 新增接收端点（经 EDP）处理 `fac.finance_result.verified`（`accepted_states=[VERIFIED]`，`DRAFT/CALCULATED` 拒绝）
- [ ] 2.3 新增 sidecar 表 `aeos_finance_result`（存引用 + 管理投影，不可编辑财务事实；保留 `currency`/`calculation_run_id`/`rule_version`/`evidence_refs`）
- [ ] 2.4 「月度经营报告」财务指标改为消费 FinanceResult（替换手工填报/自算）

**交付物**：接收端点 + sidecar 表 + 月度报告消费改造

**验收**：只接受 `VERIFIED`；`SUPERSEDED/RESTATED` 走新 revision 并保留历史；异常只生成 Exception 不改财务值。

---

#### 差距 5：DEH 执行闭环

**目标**：把现有行动项升级为 `DecisionCase → Decision → Action → Result → Verify → Evidence` 闭环。

**行动**
- [ ] 5.1 引入 `DEH_CONTRACT_V1` 契约（Goal Link / Decision / Action / Result / Evidence / Event）
- [ ] 5.2 `sop_actions` / `ai_actions` 增加 `decision_id` / `result` / `verification`（`verified_by`/`verified_at`）关联字段（不破坏现有字段）
- [ ] 5.3 「月度经营报告」的「决策清单 / 问题诊断」契约化为 `Decision` / `Exception`，输出标准 Event
- [ ] 5.4 对接 M01 的 Goal/Decision/Action 语义（不自行复制事实源）

**交付物**：DEH 契约落地 + 行动项闭环化 + 月度报告契约化

**验收**：至少一条经营异常从识别到 Decision→Action→Result→Verification→Evidence 全链路闭环（对齐 M03 方案 §九）。

---

#### 差距 6：统一身份（Keycloak OIDC）

**目标**：EBMS 接入 Keycloak 统一身份，替换自建 JWT。

**行动**
- [ ] 6.1 后端增加 OIDC token 校验（`JWKS` 验证 Keycloak 签发 token），与自建 `auth-token.js` 并行、按 `AUTH_MODE` 切换
- [ ] 6.2 前端登录接 Keycloak（authorization code + PKCE），回退自建登录
- [ ] 6.3 权限仍由 M01/EBMS 合并，Keycloak 只做身份/认证，不做业务授权

**交付物**：OIDC 校验中间件 + 登录切换 + `AUTH_MODE` 环境变量

**验收**：Keycloak 登录可正常进入 EBMS；退出/会话失效行为正确；自建登录仍可用作回滚。

---

### 阶段 P2（对齐 AEOS 36 周 Gate）

#### 差距 7：专业操作面下沉

**目标**：EBMS 停止专业录入/审批扩张，专业 CRUD 逐步下沉 M04–M09。

**行动**
- [ ] 7.1 盘点 EBMS 专业 CRUD（询价/客户/订单/物料/BOM/采购/费用/人工等），逐项标记 `Legacy / 下沉目标模块`
- [ ] 7.2 建立代码级门禁：新增专业 CRUD 走 Guardrails 评审（POS-GR-03）
- [ ] 7.3 制定下沉迁移顺序（对齐 M03 方案 W17–W36 Gate）

**交付物**：专业 CRUD 盘点清单 + 门禁规则

**验收**：不再新增跨域专业 CRUD；专业状态变化只能由 Domain Owner System 执行。

---

#### 差距 8：Owner 指定与签批

**目标**：落实各模块 Accountable Owner，使红线可追责。

**行动**
- [ ] 8.1 为 M03 EBMS 及各专业模块指定 `Accountable Business Owner` 与 `System Lead`
- [ ] 8.2 回填 AEOS `registry/owners.yaml`（当前全为 `PENDING_SIGN_OFF`）
- [ ] 8.3 EBMS `docs/AEOS_V7.2_DATA_OWNERSHIP_V1.md` 同步签批状态

**交付物**：Owner 签批记录

**验收**：`owners.yaml` 对应 `owner.m03` 状态由 `PENDING_SIGN_OFF` 转为已签批。

---

## 三、风险与依赖

| 项 | 风险 | 缓解 |
|---|---|---|
| M02 EDP / M09 FAC 未就绪 | 差距 1/2 无法端到端联调 | EBMS 侧先实现契约端点，EDP 就绪后接通；端点 fail-closed |
| 契约包引入后手改副本 | schema 漂移 | 以 AEOS `manifest.json` 指纹为准，禁止手改 |
| Keycloak 切换 | 现有自建 JWT 用户会话中断 | `AUTH_MODE` 双模式并行 + 回滚 |
| 专业 CRUD 下沉 | 业务连续性 | Legacy 继续运行，只停扩张、不做破坏性迁移 |

---

## 四、执行顺序

```
P0（并行）: 差距3 契约包 ──┬──► 差距1 人员生命周期
            差距4 注册表 ───┘
P1（依赖 P0）: 差距2 财经结果（依赖 EDP/FAC）
               差距5 DEH 闭环（依赖差距3）
               差距6 Keycloak（独立）
P2: 差距7 专业操作面下沉、差距8 Owner 签批
```

> 建议先执行 **P0 差距 1**（Phase 1 验收主线），其余按依赖推进。
