
    let bobbyConfig = null;
    let configHash = '';
    let logsHash = '';

    // -- Custom UI Utilities --
    function bobbyAlert(message, type = 'danger') {
      const toast = document.createElement('div');
      toast.style.padding = '12px 20px';
      toast.style.borderRadius = '8px';
      toast.style.color = '#fff';
      toast.style.fontWeight = '500';
      toast.style.fontSize = '0.9rem';
      toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
      toast.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(20px)';
      toast.style.display = 'flex';
      toast.style.alignItems = 'center';
      toast.style.gap = '10px';
      toast.style.backdropFilter = 'blur(12px)';
      
      if(type === 'danger') {
        toast.style.background = 'rgba(239, 68, 68, 0.2)';
        toast.style.border = '1px solid rgba(239, 68, 68, 0.5)';
      } else {
        toast.style.background = 'rgba(16, 185, 129, 0.2)';
        toast.style.border = '1px solid rgba(16, 185, 129, 0.5)';
      }
      
      toast.innerHTML = message;
      document.getElementById('toastContainer').appendChild(toast);
      
      requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
      });
      
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }

    let confirmResolver = null;
    function bobbyConfirm(message) {
      document.getElementById('confirmMessage').innerText = message;
      document.getElementById('confirmModal').classList.add('active');
      return new Promise(resolve => {
        confirmResolver = resolve;
      });
    }
    function resolveConfirm(result) {
      document.getElementById('confirmModal').classList.remove('active');
      if (confirmResolver) {
        confirmResolver(result);
        confirmResolver = null;
      }
    }

    // -- Tab Navigation --
    function switchTab(tabId) {
      document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      
      document.getElementById('tab-' + tabId).classList.add('active');
      document.getElementById('nav-' + tabId).classList.add('active');
      
      if(tabId === 'settings') renderCliTools();
      if(tabId === 'logs') loadLogs();
    }

    async function loadLogs() {
      try {
        const res = await fetch('/api/logs');
        const logsText = await res.text();
        if (logsText === logsHash) return;
        logsHash = logsText;

        const logs = JSON.parse(logsText);
        const tbody = document.getElementById('logs-tbody');
        if(logs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty-state" style="padding: 2rem">Belum ada request yang masuk bro.</td></tr>';
          return;
        }
        let html = '';
        logs.forEach(l => {
          const d = new Date(l.timestamp);
          const timeStr = d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
          let badgeClass = 'pending';
          let badgeText = 'Processing...';
          if(l.status === 'success') { badgeClass = 'success'; badgeText = 'Success'; }
          else if(l.status === 'limit') { badgeClass = 'limit'; badgeText = 'Limit (429)'; }
          else if(l.status === 'error') { badgeClass = 'error'; badgeText = 'Error'; }

          html += `
            <tr>
              <td style="color: var(--text-muted)">${timeStr}</td>
              <td style="font-weight: 500">${l.provider}</td>
              <td>${l.account}</td>
              <td><span class="badge" style="margin-left:0; background:rgba(255,255,255,0.05)">${l.model}</span></td>
              <td><span class="status-badge ${badgeClass}">${badgeText}</span></td>
            </tr>
          `;
        });
        tbody.innerHTML = html;
      } catch(e) {}
    }

    async function loadConfig() {
      try {
        const res = await fetch('/api/config');
        const text = await res.text();
        configHash = text;
        bobbyConfig = JSON.parse(text);
        renderDashboard();
        renderCliTools();
        loadLogs();
      } catch (err) {
        document.getElementById('providers-container').innerHTML = `<div class="empty-state" style="color: var(--danger)">Error loading config: ${err.message}. Is the router running?</div>`;
      }
    }

    async function syncConfig() {
      if (document.querySelector('.modal-overlay.active')) return;
      try {
        const res = await fetch('/api/config');
        const text = await res.text();
        if (text !== configHash) {
          configHash = text;
          bobbyConfig = JSON.parse(text);
          renderDashboard();
          renderCliTools();
        }
      } catch(e) {}
    }

    function renderDashboard() {
      const container = document.getElementById('providers-container');
      
      if (!bobbyConfig || !bobbyConfig.providers || bobbyConfig.providers.length === 0) {
        container.innerHTML = `<div class="empty-state">No providers configured yet. Use the + Add Provider button to get started.</div>`;
        return;
      }

      let html = '';
      bobbyConfig.providers.forEach(p => {
        let accountsHtml = '';
        if (p.accounts.length === 0) {
          accountsHtml = `<div style="color: var(--text-muted); font-size: 0.9rem;">No accounts yet.</div>`;
        } else {
          p.accounts.forEach(a => {
            const isLimit = a.status !== 'active';
            const dotClass = isLimit ? 'status-limited' : 'status-active';
            accountsHtml += `
              <div class="account-item">
                <div>
                  <span class="status-dot ${dotClass}" title="Click to toggle status" onclick="toggleAccountStatus('${p.id}', '${a.id}')"></span>
                  <strong>${a.name}</strong>
                  <span class="badge">Used: ${a.usageCount || 0}x</span>
                  ${p.lastAccountId === a.id ? '<span class="badge" style="background: rgba(56,189,248,0.2); color: var(--primary)">Current Target</span>' : ''}
                </div>
                <div>
                  ${p.lastAccountId !== a.id ? `<button class="btn" style="background: rgba(255,255,255,0.1); color: white; padding: 0.3rem 0.6rem; font-size: 0.8rem; margin-right: 0.5rem" onclick="setTargetAccount('${p.id}', '${a.id}')">Set Target</button>` : ''}
                  <button class="btn" style="background: rgba(239,68,68,0.1); color: var(--danger); padding: 0.3rem 0.6rem; font-size: 0.8rem" onclick="deleteAccount('${p.id}', '${a.id}')">Delete</button>
                </div>
              </div>
            `;
          });
        }

        html += `
          <div class="glass-card">
            <div class="provider-header">
              <div>
                <div class="provider-name">${p.name}</div>
                <div class="provider-url">${p.baseUrlTemplate}</div>
              </div>
              <div style="display:flex; gap: 0.75rem">
                <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.85rem" onclick="openAddAccountModal('${p.id}')">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                  Account
                </button>
                <button class="btn btn-danger" style="padding: 0.4rem 0.8rem; font-size: 0.85rem" onclick="deleteProvider('${p.id}')">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
              </div>
            </div>
            <div class="account-list">
              ${accountsHtml}
            </div>
          </div>
        `;
      });
      container.innerHTML = html;
    }

    // -- Settings / CLI Tools --
    function renderCliTools() {
      if(!bobbyConfig) return;
      let html = '';
      bobbyConfig.cliTools.forEach(t => {
        html += `
          <div class="account-item" style="padding: 0.75rem 1.25rem">
            <strong>${t}</strong>
            <button class="btn btn-danger" style="padding: 0.3rem 0.6rem; font-size: 0.8rem" onclick="removeCliTool('${t}')">Remove</button>
          </div>
        `;
      });
      document.getElementById('cliToolsList').innerHTML = html;
    }

    async function addCliTool() {
      const val = document.getElementById('newCliToolInput').value.trim();
      if(!val) return;
      if(!bobbyConfig.cliTools.includes(val)) {
        bobbyConfig.cliTools.push(val);
        await saveConfig();
        document.getElementById('newCliToolInput').value = '';
        renderCliTools();
      }
    }

    async function removeCliTool(tool) {
      if(bobbyConfig.cliTools.length <= 1) return bobbyAlert("Minimal harus ada 1 CLI tool bro!");
      bobbyConfig.cliTools = bobbyConfig.cliTools.filter(x => x !== tool);
      await saveConfig();
      renderCliTools();
    }

    // -- App Logic --
    async function shutdownRouter() {
      if(!(await bobbyConfirm("Matiin router sekarang?"))) return;
      try {
        await fetch('/api/shutdown', { method: 'POST' });
        document.body.innerHTML = `
          <div style="display:flex; justify-content:center; align-items:center; height:100vh; width:100vw; flex-direction:column; background: var(--bg-gradient)">
            <h1 style="color: var(--text-muted); margin-bottom: 1rem">Router Offline</h1>
            <p style="color: var(--text-muted)">Router udah sukses dimatiin. Tab ini boleh ditutup.</p>
          </div>
        `;
      } catch(e) {}
    }

    function openAddAccountModal(providerId) {
      const p = bobbyConfig.providers.find(x => x.id === providerId);
      if(!p) return;
      
      document.getElementById('providerIdInput').value = providerId;
      document.getElementById('accNameInput').value = '';
      
      let credsHtml = '';
      p.credentials.forEach(c => {
        credsHtml += `
          <div class="form-group">
            <label>${c.label}</label>
            <input type="${c.secret ? 'password' : 'text'}" id="cred_${c.key}" class="form-control credential-input" data-key="${c.key}">
          </div>
        `;
      });
      document.getElementById('dynamicCreds').innerHTML = credsHtml;
      document.getElementById('addAccountModal').classList.add('active');
    }

    let templatesCache = [];
    let selectedProviderMode = 'template';
    let selectedProviderTemplate = '';

    function switchProviderTab(mode) {
      selectedProviderMode = mode;
      if(mode === 'template') {
        document.getElementById('btnTabTemplate').className = 'btn btn-primary';
        document.getElementById('btnTabTemplate').style.background = '';
        document.getElementById('btnTabTemplate').style.color = '';
        
        document.getElementById('btnTabCustom').className = 'btn';
        document.getElementById('btnTabCustom').style.background = 'transparent';
        document.getElementById('btnTabCustom').style.color = 'var(--text-muted)';
        
        document.getElementById('provTabTemplate').style.display = 'block';
        document.getElementById('provTabCustom').style.display = 'none';
      } else {
        document.getElementById('btnTabCustom').className = 'btn btn-primary';
        document.getElementById('btnTabCustom').style.background = '';
        document.getElementById('btnTabCustom').style.color = '';
        
        document.getElementById('btnTabTemplate').className = 'btn';
        document.getElementById('btnTabTemplate').style.background = 'transparent';
        document.getElementById('btnTabTemplate').style.color = 'var(--text-muted)';
        
        document.getElementById('provTabTemplate').style.display = 'none';
        document.getElementById('provTabCustom').style.display = 'block';
      }
    }

    function selectTemplateCard(id) {
      selectedProviderTemplate = id;
      document.querySelectorAll('.template-card').forEach(el => el.classList.remove('selected'));
      const selected = document.getElementById('tpl-card-' + id);
      if(selected) selected.classList.add('selected');
    }

    async function openAddProviderModal() {
      if(templatesCache.length === 0) {
        try {
          const res = await fetch('/api/templates');
          templatesCache = await res.json();
        } catch(e) { return bobbyAlert("Gagal ngambil daftar provider"); }
      }
      
      let html = '';
      templatesCache.forEach(t => {
        html += `
          <div id="tpl-card-${t.id}" class="template-card" onclick="selectTemplateCard('${t.id}')">
            <div style="font-weight: 600; font-size: 0.95rem; margin-bottom: 4px;">${t.name}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted); font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${t.baseUrlTemplate}</div>
          </div>
        `;
      });
      document.getElementById('templateListGrid').innerHTML = html;
      
      switchProviderTab('template');
      selectedProviderTemplate = '';
      document.getElementById('customProvName').value = '';
      document.getElementById('customProvUrl').value = '';
      
      document.getElementById('addProviderModal').classList.add('active');
    }

    function closeModal(modalId) {
      if(modalId) {
        document.getElementById(modalId).classList.remove('active');
      }
    }

    async function saveNewAccount() {
      const providerId = document.getElementById('providerIdInput').value;
      const p = bobbyConfig.providers.find(x => x.id === providerId);
      
      const name = document.getElementById('accNameInput').value.trim();
      if(!name) return bobbyAlert("Isi nama akunnya bro");

      const creds = {};
      for(const inp of document.querySelectorAll('.credential-input')) {
        if(!inp.value.trim()) return bobbyAlert("Semua credential wajib diisi");
        creds[inp.dataset.key] = inp.value.trim();
      }

      const newAccount = {
        id: 'acc_' + crypto.randomUUID(),
        name: name,
        credentials: creds,
        status: 'active',
        usageCount: 0
      };

      p.accounts.push(newAccount);
      await saveConfig();
      closeModal('addAccountModal');
    }

    async function saveNewProvider() {
      let tpl;
      if (selectedProviderMode === 'template') {
        if (!selectedProviderTemplate) return bobbyAlert("Pilih template provider dulu bro!");
        tpl = templatesCache.find(x => x.id === selectedProviderTemplate);
        if(!tpl) return;
        tpl = JSON.parse(JSON.stringify(tpl));
        tpl.id = tpl.id + '_' + crypto.randomUUID();
      } else {
        const name = document.getElementById('customProvName').value.trim();
        if(!name) return bobbyAlert("Isi nama custom provider bro!");
        const baseUrl = document.getElementById('customProvUrl').value.trim();
        if(!baseUrl) return bobbyAlert("Isi Base URL bro!");
        
        tpl = {
          id: 'custom_' + crypto.randomUUID(),
          name: name,
          baseUrlTemplate: baseUrl,
          credentials: [{ key: 'apiKey', label: 'API Key', secret: true }],
          fetchModels: true
        };
      }
      
      const newProv = {
        id: tpl.id,
        name: tpl.name,
        baseUrlTemplate: tpl.baseUrlTemplate,
        credentials: tpl.credentials,
        fetchModels: tpl.fetchModels !== undefined ? tpl.fetchModels : true,
        accounts: [],
        models: [],
        lastAccountId: null
      };
      
      if(!bobbyConfig.providers) bobbyConfig.providers = [];
      bobbyConfig.providers.push(newProv);
      await saveConfig();
      closeModal('addProviderModal');
    }

    async function deleteAccount(providerId, accountId) {
      if(!(await bobbyConfirm("Yakin mau hapus akun ini?"))) return;
      const p = bobbyConfig.providers.find(x => x.id === providerId);
      if(p) {
        p.accounts = p.accounts.filter(a => a.id !== accountId);
        if(p.lastAccountId === accountId) p.lastAccountId = null;
        await saveConfig();
      }
    }

    async function toggleAccountStatus(providerId, accountId) {
      const p = bobbyConfig.providers.find(x => x.id === providerId);
      if(p) {
        const a = p.accounts.find(x => x.id === accountId);
        if(a) {
          a.status = a.status === 'active' ? 'limit' : 'active';
          await saveConfig();
        }
      }
    }

    async function setTargetAccount(providerId, accountId) {
      const p = bobbyConfig.providers.find(x => x.id === providerId);
      if(p) {
        p.lastAccountId = accountId;
        await saveConfig();
      }
    }

    async function deleteProvider(providerId) {
      if(!(await bobbyConfirm("Yakin mau hapus provider ini beserta semua akunnya?"))) return;
      bobbyConfig.providers = bobbyConfig.providers.filter(x => x.id !== providerId);
      await saveConfig();
    }

    async function saveConfig() {
      try {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bobbyConfig)
        });
        await loadConfig();
      } catch (err) {
        bobbyAlert("Gagal nyimpen config: " + err.message);
      }
    }

    // Init
    loadConfig();
    setInterval(() => {
      loadLogs();
      syncConfig();
    }, 3000); // auto-refresh logs & sync config
  