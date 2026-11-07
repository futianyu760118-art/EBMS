# EBMS × AEOS 系统注册登记

本目录是 EBMS（M03 企业经营管理系统）在 AEOS V7.2.2 体系中的自述登记，供 AEOS 治理侧（M00）与注册表观察工具消费。

## 登记内容

| 项 | 值 |
|---|---|
| system_id | M03_EBMS |
| module | M03 |
| domain | management |
| person_lifecycle_role | adapter |
| person_lifecycle_endpoint | `/internal/aeos/person-lifecycle` |
| sync_capabilities | offboard / reinstate / hide / revoke / audit |
| 契约基线 | `aeos.upstreamCommit` = `c199b17`（AEOS gitee `origin/main`，Phase 1 人员变动闭环与统一契约）|

## 契约包

AEOS Phase 1 统一契约消费自 `contracts/aeos-v1/`（8 套 schema + manifest 指纹），禁止手改；校验：

```powershell
node scripts/validate-aeos-contracts.js
```

## 登记文件

- `system-manifests/M03-EBMS.yaml` — EBMS 系统 manifest（字段对齐 AEOS `registry/system-manifests/` 格式）。

> 说明：AEOS 仓库 `registry/system-manifests/M03-EBMS.yaml` 中 `upstream_commit_source` 曾标注「aeos.upstreamCommit is not configured」；本仓库已通过 git config `aeos.upstreamCommit` 配置并在此登记，解除该告警。
