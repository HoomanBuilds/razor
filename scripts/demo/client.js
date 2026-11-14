(() => {
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return;
  const recordingParameter = new URLSearchParams(location.search).get('recording');
  if (recordingParameter === '1') sessionStorage.setItem('razor-recording-mode', '1');
  if (recordingParameter === '0') sessionStorage.removeItem('razor-recording-mode');
  const recording = sessionStorage.getItem('razor-recording-mode') === '1';
  if (recording) {
    const style = document.createElement('style');
    style.textContent = '#razor-demo-environment{display:none!important}';
    document.head.append(style);
  }
  function refresh() {
    document.querySelector('button[aria-label="Refresh workspace"]')?.click();
  }
  function addButton(container, id, label, action) {
    if (!container || document.getElementById(id)) return;
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = 'padding:12px 18px;border:1px solid #b9c8ff;border-radius:999px;background:#edf2ff;color:#1646e8;font-family:inherit;font-size:14px;font-weight:500;margin:16px 0;cursor:pointer';
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = recording ? (action === 'fund' ? 'Processing deposit...' : 'Processing payments...') : 'Simulating local records...';
      try {
        const state = await fetch('/__demo/state').then(response => response.json());
        const body = action === 'fund' ? { fundingId: state.lastFundingId } : {};
        if (action === 'fund' && !body.fundingId) throw new Error('Review funding instructions first');
        const response = await fetch('/__demo/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        await new Promise(resolve => setTimeout(resolve, 700));
        button.textContent = recording
          ? (action === 'fund' ? 'Deposit received. Balance updated.' : 'Payments completed')
          : (action === 'fund' ? 'Funding simulated. Balance updated.' : 'Delivery simulated. Both recipients paid.');
        if (action === 'fund') {
          await new Promise(resolve => setTimeout(resolve, 500));
          document.getElementById('treasury-deposit-flow')?.close();
        }
        refresh();
      } catch (error) { button.disabled = false; button.textContent = error.message; }
      finally { button.setAttribute('aria-busy', 'false'); }
    });
    (container.querySelector('.workspace-panel-body') || container).prepend(button);
  }
  const update = () => {
    addButton(document.getElementById('payroll-execution'), 'razor-demo-settle', recording ? 'Confirm payments' : 'Simulate payroll delivery', 'settle-payroll');
    addButton(document.querySelector('#treasury-deposit-flow[open]'), 'razor-demo-fund', recording ? 'Confirm deposit' : 'Simulate this funding deposit', 'fund');
  };
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  update();
})();
