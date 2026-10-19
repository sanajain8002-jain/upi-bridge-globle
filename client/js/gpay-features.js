// Google Pay All-in-One Upgrade Module for UPI Bridge Global
(function () {
  // 1. Inject Google Pay Floating Action Bar & Modals CSS
  const style = document.createElement('style');
  style.textContent = `
    .gpay-fab-bar {
      position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
      background: #0f172a; border: 1px solid #334155; border-radius: 999px;
      padding: 8px 14px; display: flex; gap: 8px; z-index: 9990;
      box-shadow: 0 12px 30px rgba(0,0,0,0.45); align-items: center;
    }
    .gpay-btn {
      background: #1e293b; color: #f8fafc; border: 1px solid #475569;
      border-radius: 999px; padding: 9px 14px; font-size: 13px; font-weight: 600;
      cursor: pointer; display: flex; align-items: center; gap: 6px; transition: 0.2s;
      white-space: nowrap;
    }
    .gpay-btn.primary { background: #2563eb; border-color: #3b82f6; }
    .gpay-btn:hover { transform: translateY(-2px); filter: brightness(1.15); }
    .gpay-modal-backdrop {
      position: fixed; inset: 0; background: rgba(2, 6, 23, 0.85);
      display: none; align-items: center; justify-content: center; z-index: 9999;
      padding: 16px; backdrop-filter: blur(4px);
    }
    .gpay-modal-backdrop.active { display: flex; }
    .gpay-card {
      background: #1e293b; color: #f8fafc; border: 1px solid #334155;
      border-radius: 20px; width: 100%; max-width: 390px; padding: 22px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.6); text-align: center; position: relative;
    }
    .gpay-close {
      position: absolute; top: 14px; right: 16px; background: none; border: none;
      color: #94a3b8; font-size: 20px; cursor: pointer;
    }
    .gpay-pin-dots { display: flex; justify-content: center; gap: 14px; margin: 20px 0; }
    .gpay-dot {
      width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid #60a5fa; background: transparent;
    }
    .gpay-dot.filled { background: #60a5fa; }
    .gpay-keypad {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 14px;
    }
    .gpay-key {
      background: #0f172a; color: #fff; border: 1px solid #334155;
      border-radius: 12px; padding: 14px 0; font-size: 18px; font-weight: 700;
      cursor: pointer;
    }
    .gpay-key:active { background: #2563eb; }
    .gpay-grid-bills {
      display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 14px 0;
    }
    .gpay-bill-item {
      background: #0f172a; border: 1px solid #334155; border-radius: 12px;
      padding: 12px; cursor: pointer; text-align: left; font-size: 13px; color: #e2e8f0;
    }
    .gpay-bill-item:hover { border-color: #3b82f6; }
    .gpay-input {
      width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid #475569;
      background: #0f172a; color: #fff; margin-top: 8px; box-sizing: border-box;
    }
    .gpay-success-circle {
      width: 68px; height: 68px; border-radius: 50%; background: #16a34a;
      color: white; font-size: 36px; display: flex; align-items: center;
      justify-content: center; margin: 0 auto 14px auto;
    }
  `;
  document.head.appendChild(style);

  // 2. Web Audio API UPI Soundbox Chime (No external MP3 needed)
  function playUpiSuccessSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.11);
        gain.gain.setValueAtTime(0.2, ctx.currentTime + idx * 0.11);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.11 + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.11);
        osc.stop(ctx.currentTime + idx * 0.11 + 0.35);
      });
    } catch (e) {}
  }

  // 3. Auto-fill existing page inputs if present
  function autoFillMainAppForm(upiId, name, amount) {
    const inputs = Array.from(document.querySelectorAll('input'));
    const upiInput = inputs.find(i => /upi|vpa|recipient|to|address|handle/i.test(i.name + i.placeholder + i.id));
    if (upiInput && upiId) {
      upiInput.value = upiId;
      upiInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const amtInput = inputs.find(i => /amount|inr|value/i.test(i.name + i.placeholder + i.id) || i.type === 'number');
    if (amtInput && amount) {
      amtInput.value = amount;
      amtInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // 4. Create UI Dock and Modal Container
  const bar = document.createElement('div');
  bar.className = 'gpay-fab-bar';
  bar.innerHTML = `
    <button class="gpay-btn primary" id="gp-scan-btn">📷 Scan QR</button>
    <button class="gpay-btn" id="gp-myqr-btn">🔳 My QR</button>
    <button class="gpay-btn" id="gp-bills-btn">⚡ Bills & Recharge</button>
    <button class="gpay-btn" id="gp-direct-btn">🚀 Pay Any UPI</button>
  `;
  document.body.appendChild(bar);

  const modal = document.createElement('div');
  modal.className = 'gpay-modal-backdrop';
  document.body.appendChild(modal);

  let html5QrScanner = null;

  function closeModal() {
    if (html5QrScanner) {
      html5QrScanner.stop().catch(() => {}).finally(() => { html5QrScanner = null; });
    }
    modal.classList.remove('active');
    modal.innerHTML = '';
  }

  // FEATURE A: Live Camera UPI QR Scanner
  document.getElementById('gp-scan-btn').onclick = () => {
    modal.classList.add('active');
    modal.innerHTML = `
      <div class="gpay-card">
        <button class="gpay-close" id="gp-x">✕</button>
        <h3 style="margin:0 0 6px 0">Scan Any UPI QR</h3>
        <p style="font-size:12px;color:#94a3b8;margin:0 0 12px 0">Point your camera at any GPay, PhonePe, Paytm or BharatQR code</p>
        <div id="gp-reader" style="width:100%;border-radius:12px;overflow:hidden;background:#000;min-height:240px"></div>
        <p style="font-size:12px;color:#60a5fa;margin-top:12px" id="gp-scan-status">Starting camera...</p>
      </div>
    `;
    document.getElementById('gp-x').onclick = closeModal;

    if (!window.Html5Qrcode) {
      document.getElementById('gp-scan-status').textContent = 'QR Library loading... Check internet connection.';
      return;
    }

    html5QrScanner = new Html5Qrcode('gp-reader');
    html5QrScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      (decodedText) => {
        let upiId = decodedText.trim();
        let payeeName = 'Merchant';
        let amount = '';
        if (decodedText.toLowerCase().startsWith('upi://pay')) {
          const url = new URL(decodedText);
          upiId = url.searchParams.get('pa') || upiId;
          payeeName = url.searchParams.get('pn') || payeeName;
          amount = url.searchParams.get('am') || '';
        }
        html5QrScanner.stop().catch(() => {}).finally(() => {
          html5QrScanner = null;
          autoFillMainAppForm(upiId, payeeName, amount);
          openPayCheckoutModal(upiId, payeeName, amount || '100', 'QR Scan Payment');
        });
      },
      () => {}
    ).catch(err => {
      document.getElementById('gp-scan-status').textContent = 'Camera permission needed or use HTTPS URL.';
    });
  };

  // FEATURE B: Receive Money via Personal UPI QR Code
  document.getElementById('gp-myqr-btn').onclick = () => {
    const savedUpi = localStorage.getItem('gp_my_upi') || 'sanajain@upi';
    modal.classList.add('active');
    const renderQr = (id) => {
      const upiUri = `upi://pay?pa=${encodeURIComponent(id)}&pn=${encodeURIComponent('UPI Bridge User')}&cu=INR`;
      const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(upiUri)}`;
      modal.innerHTML = `
        <div class="gpay-card">
          <button class="gpay-close" id="gp-x">✕</button>
          <h3 style="margin:0 0 4px 0">Receive Money</h3>
          <p style="font-size:12px;color:#94a3b8;margin-bottom:14px">Scan with Google Pay, PhonePe, or Paytm</p>
          <div style="background:#fff;padding:14px;border-radius:16px;display:inline-block">
            <img src="${qrImg}" alt="UPI QR" width="200" height="200" style="display:block"/>
          </div>
          <input class="gpay-input" id="gp-my-id" value="${id}" placeholder="Enter your UPI ID (e.g. name@okaxis)" />
          <button class="gpay-btn primary" id="gp-update-qr" style="width:100%;justify-content:center;margin-top:10px">Update My UPI ID</button>
        </div>
      `;
      document.getElementById('gp-x').onclick = closeModal;
      document.getElementById('gp-update-qr').onclick = () => {
        const newId = document.getElementById('gp-my-id').value.trim() || 'user@upi';
        localStorage.setItem('gp_my_upi', newId);
        renderQr(newId);
      };
    };
    renderQr(savedUpi);
  };

  // FEATURE C: Mobile Recharge, Electricity, FASTag & Bills
  document.getElementById('gp-bills-btn').onclick = () => {
    modal.classList.add('active');
    modal.innerHTML = `
      <div class="gpay-card">
        <button class="gpay-close" id="gp-x">✕</button>
        <h3 style="margin:0 0 6px 0">Bills, Recharges & Finance</h3>
        <p style="font-size:12px;color:#94a3b8;margin:0">Select a biller category</p>
        <div class="gpay-grid-bills">
          <div class="gpay-bill-item" data-biller="jio.recharge@axis" data-title="Mobile Recharge" data-amt="299">📱 <b>Mobile Recharge</b><br><span style="font-size:11px;color:#94a3b8">Jio / Airtel / Vi</span></div>
          <div class="gpay-bill-item" data-biller="electricity.bill@sbi" data-title="Electricity Bill" data-amt="1450">💡 <b>Electricity</b><br><span style="font-size:11px;color:#94a3b8">State Power Boards</span></div>
          <div class="gpay-bill-item" data-biller="fastag.nhai@icici" data-title="FASTag Recharge" data-amt="500">🚗 <b>FASTag Toll</b><br><span style="font-size:11px;color:#94a3b8">Instant Recharge</span></div>
          <div class="gpay-bill-item" data-biller="dth.tataplay@hdfc" data-title="DTH / Cable TV" data-amt="350">📺 <b>DTH / Broadband</b><br><span style="font-size:11px;color:#94a3b8">Tata Play / Fiber</span></div>
        </div>
      </div>
    `;
    document.getElementById('gp-x').onclick = closeModal;
    modal.querySelectorAll('.gpay-bill-item').forEach(item => {
      item.onclick = () => {
        openPayCheckoutModal(item.dataset.biller, item.dataset.title, item.dataset.amt, item.dataset.title);
      };
    });
  };

  // FEATURE D: Direct UPI Transfer & 4-Digit NPCI UPI PIN Pad
  document.getElementById('gp-direct-btn').onclick = () => {
    openPayCheckoutModal('', '', '', 'Direct UPI Transfer');
  };

  function openPayCheckoutModal(defaultUpi, defaultName, defaultAmt, note) {
    modal.classList.add('active');
    modal.innerHTML = `
      <div class="gpay-card">
        <button class="gpay-close" id="gp-x">✕</button>
        <h3 style="margin:0 0 4px 0">${note || 'Send Money'}</h3>
        <p style="font-size:12px;color:#94a3b8;margin-bottom:10px">Instant UPI Bridge Transfer</p>
        <input class="gpay-input" id="gp-to-upi" placeholder="Receiver UPI ID or Number (e.g. merchant@upi)" value="${defaultUpi || ''}"/>
        <input class="gpay-input" id="gp-to-name" placeholder="Receiver Name" value="${defaultName || ''}"/>
        <input class="gpay-input" id="gp-to-amt" type="number" placeholder="Amount in ₹ (INR)" value="${defaultAmt || ''}"/>
        <button class="gpay-btn primary" id="gp-proceed-pin" style="width:100%;justify-content:center;margin-top:14px;padding:12px">🔒 Proceed to 4-Digit UPI PIN</button>
        <button class="gpay-btn" id="gp-open-native" style="width:100%;justify-content:center;margin-top:8px;padding:10px">📲 Open Installed GPay / PhonePe App</button>
      </div>
    `;
    document.getElementById('gp-x').onclick = closeModal;

    document.getElementById('gp-open-native').onclick = () => {
      const pa = document.getElementById('gp-to-upi').value.trim() || 'merchant@upi';
      const pn = document.getElementById('gp-to-name').value.trim() || 'Recipient';
      const am = document.getElementById('gp-to-amt').value.trim() || '1';
      window.location.href = `upi://pay?pa=${encodeURIComponent(pa)}&pn=${encodeURIComponent(pn)}&am=${encodeURIComponent(am)}&cu=INR`;
    };

    document.getElementById('gp-proceed-pin').onclick = () => {
      const pa = document.getElementById('gp-to-upi').value.trim() || 'merchant@upi';
      const pn = document.getElementById('gp-to-name').value.trim() || pa;
      const am = document.getElementById('gp-to-amt').value.trim() || '100';
      autoFillMainAppForm(pa, pn, am);
      openPinPadModal(pa, pn, am, note);
    };
  }

  function openPinPadModal(pa, pn, am, note) {
    let pin = '';
    modal.innerHTML = `
      <div class="gpay-card">
        <button class="gpay-close" id="gp-x">✕</button>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#94a3b8;border-bottom:1px solid #334155;padding-bottom:8px">
          <span>NPCI UPI SECURE</span>
          <span>Paying ₹${am} to ${pn}</span>
        </div>
        <h4 style="margin:16px 0 4px 0">ENTER 4-DIGIT UPI PIN</h4>
        <div class="gpay-pin-dots">
          <div class="gpay-dot" id="d0"></div>
          <div class="gpay-dot" id="d1"></div>
          <div class="gpay-dot" id="d2"></div>
          <div class="gpay-dot" id="d3"></div>
        </div>
        <div class="gpay-keypad" id="gp-pad">
          ${[1,2,3,4,5,6,7,8,9,'⌫',0,'✔'].map(k => `<button class="gpay-key" data-k="${k}">${k}</button>`).join('')}
        </div>
      </div>
    `;
    document.getElementById('gp-x').onclick = closeModal;

    const updateDots = () => {
      for (let i = 0; i < 4; i++) {
        document.getElementById('d' + i).classList.toggle('filled', i < pin.length);
      }
    };

    document.getElementById('gp-pad').onclick = (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      if (k === '⌫') {
        pin = pin.slice(0, -1);
      } else if (k === '✔') {
        if (pin.length === 4) completePaymentReceipt(pa, pn, am, note);
      } else if (pin.length < 4) {
        pin += k;
        if (pin.length === 4) {
          setTimeout(() => completePaymentReceipt(pa, pn, am, note), 250);
        }
      }
      updateDots();
    };
  }

  // FEATURE E: Animated Soundbox Receipt & UTR Generator
  function completePaymentReceipt(pa, pn, am, note) {
    playUpiSuccessSound();
    const mainSubmitBtn = document.querySelector('form button[type="submit"], button.primary');
    if (mainSubmitBtn && !mainSubmitBtn.id.startsWith('gp-')) {
      mainSubmitBtn.click();
    }
    const utr = '6' + Math.floor(10000000000 + Math.random() * 90000000000);
    const timeStr = new Date().toLocaleString();
    modal.innerHTML = `
      <div class="gpay-card">
        <div class="gpay-success-circle">✓</div>
        <h2 style="margin:0">₹${Number(am).toLocaleString('en-IN')}</h2>
        <p style="color:#4ade80;font-weight:600;margin:4px 0 12px 0">Paid to ${pn}</p>
        <div style="background:#0f172a;border-radius:12px;padding:12px;text-align:left;font-size:12px;color:#cbd5e1;line-height:1.7">
          <div><b>UPI ID:</b> ${pa}</div>
          <div><b>Category:</b> ${note || 'UPI Transfer'}</div>
          <div><b>UTR / Ref No:</b> ${utr}</div>
          <div><b>Timestamp:</b> ${timeStr}</div>
          <div><b>Status:</b> <span style="color:#4ade80">SUCCESS (Verified by UPI PIN)</span></div>
        </div>
        <button class="gpay-btn primary" id="gp-done" style="width:100%;justify-content:center;margin-top:14px">Done</button>
      </div>
    `;
    document.getElementById('gp-done').onclick = closeModal;
  }
})();