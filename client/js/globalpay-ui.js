// GlobalPay Dashboard UI Injector
(function () {
  window.addEventListener('DOMContentLoaded', () => {
    // Update App Title and Branding
    document.title = "GlobalPay | Secure Global UPI";
    
    // Inject GlobalPay Top Banner & Action Grid if user view exists
    const container = document.querySelector('main, #app, .container, body');
    if (!container) return;

    const gpBanner = document.createElement('div');
    gpBanner.innerHTML = `
      <div class="globalpay-header">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <span class="globalpay-badge">⚡ SECURE NEO-WALLET</span>
            <h1 style="margin:8px 0 2px 0; font-size:22px; letter-spacing:-0.5px;">GlobalPay</h1>
            <p style="margin:0; font-size:12px; color:var(--gp-text-muted);">Cross-Border UPI & Instant Payments</p>
          </div>
          <div style="text-align:right;">
            <div style="font-size:11px; color:var(--gp-text-muted);">Active Balance</div>
            <div style="font-size:18px; font-weight:700; color:var(--gp-accent);" id="gp-live-bal">₹45,850.00</div>
          </div>
        </div>
      </div>

      <div class="globalpay-action-grid">
        <div class="globalpay-action-card" onclick="document.getElementById('gp-scan-btn')?.click()">
          <div class="globalpay-action-icon">📷</div>
          <div style="font-size:11px; font-weight:600;">Scan QR</div>
        </div>
        <div class="globalpay-action-card" onclick="document.getElementById('gp-direct-btn')?.click()">
          <div class="globalpay-action-icon">💸</div>
          <div style="font-size:11px; font-weight:600;">Pay UPI</div>
        </div>
        <div class="globalpay-action-card" onclick="document.getElementById('gp-myqr-btn')?.click()">
          <div class="globalpay-action-icon">🔳</div>
          <div style="font-size:11px; font-weight:600;">Receive</div>
        </div>
        <div class="globalpay-action-card" onclick="document.getElementById('gp-bills-btn')?.click()">
          <div class="globalpay-action-icon">⚡</div>
          <div style="font-size:11px; font-weight:600;">Bills</div>
        </div>
      </div>
    `;
    
    // Insert at the very top of the main view
    container.insertBefore(gpBanner, container.firstChild);
  });
})();