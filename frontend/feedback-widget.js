/**
 * 全局用户反馈悬浮控件
 * ---------------------------------------------------------------
 * - 所有页面右下角提供「反馈」按钮（在聊天按钮左侧，避免遮挡）
 * - 「提交反馈」：类型/优先级/标题/描述/截图链接，自动带上当前页面模块
 * - 「我的反馈」：查看本人提交的反馈列表与处理状态、跟进时间线，可追加跟进
 * - 依赖：localStorage.currentUserId（登录态）、window.fetch（权限脚本已注入 x-user-id）
 */
(function () {
  if (window.__feedbackWidgetInstalled) return;
  window.__feedbackWidgetInstalled = true;

  var API = '/api/feedback';
  var TYPE_MAP = { bug: '缺陷', feature: '功能需求', improvement: '改进建议', question: '问题咨询' };
  var PRIORITY_MAP = { low: '低', medium: '中', high: '高', urgent: '紧急' };
  var STATUS_MAP = { open: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' };
  var STATUS_COLOR = { open: '#16a34a', processing: '#2563eb', resolved: '#d97706', closed: '#6b7280' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function toast(msg, ok) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:100001;padding:10px 18px;border-radius:8px;'
      + 'font-size:13px;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.18);background:' + (ok === false ? '#dc2626' : '#16a34a');
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }, 2000);
    setTimeout(function () { t.remove(); }, 2400);
  }
  function currentModule() {
    try {
      return (document.body && document.body.dataset && document.body.dataset.pageTitle)
        || (document.title || '').split(/[-—|]/)[0].trim()
        || location.pathname.replace(/^\//, '').replace(/\.html$/, '') || '未知页面';
    } catch (e) { return '未知页面'; }
  }
  function currentUserName() {
    try { return localStorage.getItem('currentUser') || ''; } catch (e) { return ''; }
  }

  function buildUI() {
    var wrap = document.createElement('div');
    wrap.id = 'feedbackWidget';
    wrap.innerHTML = ''
      + '<div id="fbPanel">'
      + '  <div class="fb-head"><span>用户反馈</span><span class="fb-close" title="关闭">×</span></div>'
      + '  <div class="fb-tabs"><button class="fb-tab active" data-tab="submit">提交反馈</button><button class="fb-tab" data-tab="mine">我的反馈 <b id="fbMineCnt"></b></button></div>'
      + '  <div class="fb-body">'
      + '    <div class="fb-pane active" id="fbPaneSubmit">'
      + '      <div id="fbReceipt" style="display:none;padding:30px 0;text-align:center">'
      + '        <div style="font-size:36px;color:#16a34a;line-height:1">✓</div>'
      + '        <div style="font-size:15px;font-weight:700;margin:10px 0 4px">提交成功</div>'
      + '        <div style="font-size:12px;color:#64748b;margin-bottom:16px">反馈编号：<b id="fbReceiptId"></b>　状态：待处理</div>'
      + '        <button class="fb-btn primary" id="fbNewBtn">再提一条</button>'
      + '      </div>'
      + '      <div id="fbFormWrap">'
      + '      <div class="fb-row"><label>类型</label><select id="fbType">'
      + '        <option value="bug">缺陷（功能异常）</option><option value="feature">功能需求</option>'
      + '        <option value="improvement">改进建议</option><option value="question">问题咨询</option></select></div>'
      + '      <div class="fb-row"><label>优先级</label><select id="fbPriority">'
      + '        <option value="medium">中</option><option value="low">低</option><option value="high">高</option><option value="urgent">紧急</option></select></div>'
      + '      <div class="fb-row"><label>标题 <i>*</i></label><input id="fbTitle" maxlength="80" placeholder="一句话说明问题或建议"></div>'
      + '      <div class="fb-row"><label>详细描述</label><textarea id="fbDesc" maxlength="2000" placeholder="操作步骤、期望结果、实际结果（便于快速定位）"></textarea></div>'
      + '      <div class="fb-row"><label>截图链接（选填）</label><input id="fbShot" placeholder="可粘贴图片链接"></div>'
      + '      <div class="fb-meta">所在页面：<b id="fbModule"></b>　提交人：<b id="fbSubmitter"></b></div>'
      + '      <div class="fb-actions"><button class="fb-btn primary" id="fbSubmit">提交反馈</button></div>'
      + '      </div>'
      + '    </div>'
      + '    <div class="fb-pane" id="fbPaneMine"><div id="fbMineList" class="fb-list"><div class="fb-empty">加载中…</div></div></div>'
      + '  </div>'
      + '</div>'
      + '<button id="fbFab" title="用户反馈"><span class="fb-ico">✎</span><span class="fb-txt">反馈</span></button>';

    var style = document.createElement('style');
    style.textContent = ''
      + '#feedbackWidget{position:fixed;right:24px;bottom:24px;z-index:99998;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}'
      + '#fbFab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;width:56px;height:56px;padding:0;border:none;border-radius:50%;background:#2563eb;color:#fff;'
      + 'cursor:grab;touch-action:none;user-select:none;box-shadow:0 4px 12px rgba(0,0,0,.22);transition:background .16s,transform .16s}'
      + '#fbFab:hover{background:#1d4ed8}#fbFab:active{cursor:grabbing}'
      + '#fbFab .fb-ico{font-size:20px;line-height:1}#fbFab .fb-txt{font-size:11px;line-height:1}'
      + '#fbPanel{position:fixed;top:0;right:0;bottom:0;width:520px;max-width:100vw;background:#fff;border-left:1px solid #e3e8ef;'
      + 'box-shadow:-8px 0 40px rgba(16,24,40,.18);transform:translateX(100%);transition:transform .25s ease;display:flex;flex-direction:column;z-index:99999;overflow:hidden}'
      + '#fbPanel.open{transform:translateX(0)}'
      + '.fb-head{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#172033;color:#fff;font-size:14px;font-weight:600}'
      + '.fb-head .fb-close{cursor:pointer;font-size:20px;line-height:1;opacity:.8}.fb-head .fb-close:hover{opacity:1}'
      + '.fb-tabs{display:flex;border-bottom:1px solid #eef1f6}#fbMineCnt{color:#2563eb}'
      + '.fb-tab{flex:1;padding:10px;border:none;background:none;cursor:pointer;font-size:13px;color:#536176;border-bottom:2px solid transparent}'
      + '.fb-tab.active{color:#2563eb;border-bottom-color:#2563eb;font-weight:600}'
      + '.fb-body{flex:1;overflow-y:auto}'
      + '.fb-pane{display:none;padding:14px 16px}.fb-pane.active{display:block}'
      + '.fb-row{margin-bottom:10px}.fb-row label{display:block;font-size:12px;color:#536176;font-weight:600;margin-bottom:5px}'
      + '.fb-row label i{color:#dc2626;font-style:normal}'
      + '.fb-row input,.fb-row select,.fb-row textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e3e8ef;border-radius:6px;font-size:13px;color:#172033;background:#fff}'
      + '.fb-row textarea{min-height:86px;resize:vertical}'
      + '.fb-row input:focus,.fb-row select:focus,.fb-row textarea:focus{outline:0;border-color:#93c5fd;box-shadow:0 0 0 3px rgba(37,99,235,.1)}'
      + '.fb-meta{font-size:11px;color:#8b98aa;margin:2px 0 12px}'
      + '.fb-actions{text-align:right}'
      + '.fb-btn{padding:8px 18px;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer}'
      + '.fb-btn.primary{background:#2563eb;color:#fff}.fb-btn.primary:hover{background:#1d4ed8}'
      + '.fb-btn.ghost{background:#f1f4f8;color:#536176;margin-left:8px}'
      + '.fb-list{display:flex;flex-direction:column;gap:8px}'
      + '.fb-empty{text-align:center;color:#8b98aa;font-size:13px;padding:26px 0}'
      + '.fb-item{border:1px solid #eef1f6;border-radius:8px;padding:10px;cursor:pointer;background:#fff;transition:border-color .15s,box-shadow .15s}'
      + '.fb-item:hover{border-color:#bfdbfe;box-shadow:0 2px 10px rgba(37,99,235,.08)}'
      + '.fb-item .fb-it-title{font-size:13px;font-weight:600;color:#172033;display:flex;justify-content:space-between;gap:8px}'
      + '.fb-item .fb-it-sub{font-size:11px;color:#8b98aa;margin-top:5px;display:flex;gap:10px;flex-wrap:wrap}'
      + '.fb-badge{display:inline-block;padding:1px 8px;border-radius:9px;font-size:11px;font-weight:600;color:#fff;white-space:nowrap}'
      + '.fb-tl{margin-top:10px;border-top:1px dashed #e3e8ef;padding-top:10px}'
      + '.fb-tl-item{position:relative;padding-left:14px;margin-bottom:10px}'
      + '.fb-tl-item:before{content:"";position:absolute;left:0;top:5px;width:6px;height:6px;border-radius:50%;background:#2563eb}'
      + '.fb-tl-head{font-size:11px;color:#8b98aa;display:flex;gap:8px;flex-wrap:wrap}'
      + '.fb-tl-content{font-size:12px;color:#172033;margin-top:3px;white-space:pre-wrap;word-break:break-word}'
      + '.fb-add{margin-top:8px}.fb-add textarea{width:100%;box-sizing:border-box;min-height:56px;padding:7px 9px;border:1px solid #e3e8ef;border-radius:6px;font-size:12px}'
      + '@media (max-width:520px){#feedbackWidget{right:74px}#fbPanel{width:calc(100vw - 16px)}}'
      + '@media print{#feedbackWidget{display:none}}';

    document.head.appendChild(style);
    document.body.appendChild(wrap);
    return wrap;
  }

  function render() {
    if (document.getElementById('feedbackWidget')) return;
    // 已登录即显示（currentUserId 或 authToken 任一即可，避免部分登录路径缺 currentUserId 时反馈控件不出现）
    if (!localStorage.getItem('currentUserId') && !localStorage.getItem('authToken')) return;
    var root = buildUI();
    document.getElementById('fbModule').textContent = currentModule();
    document.getElementById('fbSubmitter').textContent = currentUserName() || '当前用户';

    var panel = document.getElementById('fbPanel');
    var fab = document.getElementById('fbFab');
    // 悬浮球可拖拽（M04 风格）：拖动超过 4px 视为拖拽，不触发打开
    (function () {
      var drag = { moved: false, sx: 0, sy: 0, oleft: 0, otop: 0 };
      fab.addEventListener('pointerdown', function (e) {
        drag.moved = false; drag.sx = e.clientX; drag.sy = e.clientY;
        var r = fab.getBoundingClientRect();
        drag.oleft = r.left; drag.otop = r.top;
        try { fab.setPointerCapture(e.pointerId); } catch (_) {}
        function onMove(ev) {
          var dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
          if (!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) drag.moved = true;
          if (!drag.moved) return;
          var s = 56;
          fab.style.left = Math.max(0, Math.min(window.innerWidth - s, drag.oleft + dx)) + 'px';
          fab.style.top = Math.max(0, Math.min(window.innerHeight - s, drag.otop + dy)) + 'px';
          fab.style.right = 'auto'; fab.style.bottom = 'auto';
        }
        function onUp() {
          fab.removeEventListener('pointermove', onMove);
          fab.removeEventListener('pointerup', onUp);
        }
        fab.addEventListener('pointermove', onMove);
        fab.addEventListener('pointerup', onUp, { once: true });
      });
      fab.addEventListener('click', function () {
        if (drag.moved) return;
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) loadMine();
      });
    })();
    root.querySelector('.fb-close').onclick = function () { panel.classList.remove('open'); };

    root.querySelectorAll('.fb-tab').forEach(function (btn) {
      btn.onclick = function () {
        root.querySelectorAll('.fb-tab').forEach(function (b) { b.classList.remove('active'); });
        root.querySelectorAll('.fb-pane').forEach(function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab === 'submit' ? 'fbPaneSubmit' : 'fbPaneMine').classList.add('active');
        if (btn.dataset.tab === 'mine') loadMine();
      };
    });

    document.getElementById('fbSubmit').onclick = function () {
      var title = document.getElementById('fbTitle').value.trim();
      if (!title) { toast('请填写标题', false); return; }
      var payload = {
        title: title,
        description: document.getElementById('fbDesc').value.trim(),
        type: document.getElementById('fbType').value,
        priority: document.getElementById('fbPriority').value,
        module: currentModule(),
        submitter: currentUserName() || '',
        screenshots: document.getElementById('fbShot').value.trim(),
        source: 'widget'
      };
      var btn = document.getElementById('fbSubmit');
      btn.disabled = true; btn.textContent = '提交中…';
      fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          btn.disabled = false; btn.textContent = '提交反馈';
          if (!res.ok) { toast((res.d && res.d.error) || '提交失败', false); return; }
          // 提交回执（M04 风格：编号 + 状态 + 再提一条）
          var created = (res.d && res.d.data) || {};
          var rid = document.getElementById('fbReceiptId');
          if (rid) rid.textContent = created.id ? ('#' + created.id) : '—';
          var fw = document.getElementById('fbFormWrap');
          var rc = document.getElementById('fbReceipt');
          if (fw) fw.style.display = 'none';
          if (rc) rc.style.display = 'block';
          document.getElementById('fbTitle').value = '';
          document.getElementById('fbDesc').value = '';
          document.getElementById('fbShot').value = '';
        })
        .catch(function () { btn.disabled = false; btn.textContent = '提交反馈'; toast('网络异常，请稍后重试', false); });
    };
    var newBtn = document.getElementById('fbNewBtn');
    if (newBtn) newBtn.onclick = function () {
      var fw = document.getElementById('fbFormWrap');
      var rc = document.getElementById('fbReceipt');
      if (rc) rc.style.display = 'none';
      if (fw) fw.style.display = 'block';
    };

    // 反馈控件对所有登录用户可见（feedback:create 为全局基础权限，后端提交时校验）。
    // 不再因权限判断延迟隐藏，避免权限接口偶发失败或非 admin 账号导致"反馈功能消失"。

    window.__feedbackWidgetRefresh = loadMine;
  }

  function loadMine() {
    var listEl = document.getElementById('fbMineList');
    if (!listEl) return;
    listEl.innerHTML = '<div class="fb-empty">加载中…</div>';
    fetch(API + '?mine=1&limit=50')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var items = (d && d.data) || [];
        var cnt = document.getElementById('fbMineCnt');
        if (cnt) cnt.textContent = items.length ? '(' + items.length + ')' : '';
        if (!items.length) { listEl.innerHTML = '<div class="fb-empty">您还没有提交过反馈</div>'; return; }
        listEl.innerHTML = items.map(function (f) {
          return '<div class="fb-item" data-id="' + f.id + '">'
            + '<div class="fb-it-title"><span>' + esc((f.title || '').substring(0, 30)) + '</span>'
            + '<span class="fb-badge" style="background:' + (STATUS_COLOR[f.status] || '#6b7280') + '">' + esc(STATUS_MAP[f.status] || f.status || '-') + '</span></div>'
            + '<div class="fb-it-sub"><span>类型：' + esc(TYPE_MAP[f.type] || f.type || '-') + '</span>'
            + '<span>优先级：' + esc(PRIORITY_MAP[f.priority] || f.priority || '-') + '</span>'
            + '<span>跟进 ' + (f.followup_count || 0) + ' 条</span>'
            + '<span>' + esc((f.created_at || '').substring(0, 16)) + '</span></div>'
            + '<div class="fb-tl" data-tl="' + f.id + '" style="display:none"></div>'
            + '</div>';
        }).join('');
        listEl.querySelectorAll('.fb-item').forEach(function (el) {
          el.onclick = function (ev) {
            if (ev.target.closest('.fb-add')) return;
            toggleTimeline(el, el.dataset.id);
          };
        });
      })
      .catch(function () { listEl.innerHTML = '<div class="fb-empty">加载失败，请稍后重试</div>'; });
  }

  function toggleTimeline(itemEl, id) {
    var tl = itemEl.querySelector('.fb-tl');
    if (!tl) return;
    if (tl.style.display === 'block') { tl.style.display = 'none'; return; }
    tl.style.display = 'block';
    loadTimeline(itemEl, id);
  }

  function loadTimeline(itemEl, id) {
    var tl = itemEl.querySelector('.fb-tl');
    if (!tl) return;
    tl.style.display = 'block';
    tl.innerHTML = '<div class="fb-empty">加载中…</div>';
    fetch(API + '/' + id)
      .then(function (r) { return r.json(); })
      .then(function (f) {
        var fus = (f && f.followups) || [];
        var html = '';
        if (f.description) html += '<div class="fb-tl-item"><div class="fb-tl-head"><b>反馈描述</b></div><div class="fb-tl-content">' + esc(f.description) + '</div></div>';
        html += fus.map(function (x) {
          var head = '<span>' + esc(x.operator || '-') + '</span><span>' + esc((x.created_at || '').substring(0, 16)) + '</span>';
          if (x.status_to && x.status_from && x.status_to !== x.status_from) {
            head += '<span>状态：' + esc(STATUS_MAP[x.status_from] || x.status_from) + ' → ' + esc(STATUS_MAP[x.status_to] || x.status_to) + '</span>';
          }
          if (x.assignee) head += '<span>处理人：' + esc(x.assignee) + '</span>';
          return '<div class="fb-tl-item"><div class="fb-tl-head">' + head + '</div>'
            + (x.content ? '<div class="fb-tl-content">' + esc(x.content) + '</div>' : '') + '</div>';
        }).join('');
        if (!fus.length && !f.description) html = '<div class="fb-empty">暂无跟进记录</div>';
        html += '<div class="fb-add"><textarea id="fbAdd_' + id + '" placeholder="补充说明或跟进留言…"></textarea>'
          + '<div style="text-align:right;margin-top:6px"><button class="fb-btn primary" data-add="' + id + '">追加跟进</button></div></div>';
        tl.innerHTML = html;
        tl.querySelector('[data-add]').onclick = function () {
          var ta = tl.querySelector('#fbAdd_' + id);
          var content = (ta.value || '').trim();
          if (!content) { toast('请填写跟进内容', false); return; }
          fetch(API + '/' + id + '/followups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: content }) })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (res) {
              if (!res.ok) { toast((res.d && res.d.error) || '跟进失败', false); return; }
              toast('已追加跟进');
              loadTimeline(itemEl, id);
            });
        };
      })
      .catch(function () { tl.innerHTML = '<div class="fb-empty">加载失败</div>'; });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(render, 0);
  } else {
    window.addEventListener('load', render);
  }
})();
