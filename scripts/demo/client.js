(() => {
  function refresh() {
    document.querySelector('button[aria-label="Refresh workspace"]')?.click();
  }
  function addButton(container, id, label, action) {
    if (!container || document.getElementById(id)) return;
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = 'padding:12px 18px;border:1px solid #b9c8ff;border-radius:14px;background:#edf2ff;color:#1646e8;font:500 14px Arial;margin:16px 0;cursor:pointer';
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Simulating local records...';
      try {
        const state = await fetch('/__demo/state').then(response => response.json());
        const body = action === 'fund' ? { fundingId: state.lastFundingId } : {};
        if (action === 'fund' && !body.fundingId) throw new Error('Review funding instructions first');
        const response = await fetch('/__demo/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        await new Promise(resolve => setTimeout(resolve, 700));
        button.textContent = action === 'fund' ? 'Funding simulated. Balance updated.' : 'Delivery simulated. Both recipients paid.';
        if (action === 'fund') document.getElementById('treasury-deposit-flow')?.close();
        refresh();
      } catch (error) { button.disabled = false; button.textContent = error.message; }
    });
    container.prepend(button);
  }
  const update = () => {
    addButton(document.getElementById('payroll-execution'), 'razor-demo-settle', 'Simulate payroll delivery', 'settle-payroll');
    addButton(document.querySelector('#treasury-deposit-flow[open]'), 'razor-demo-fund', 'Simulate this funding deposit', 'fund');
  };
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  update();
})();
