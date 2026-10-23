/* Keep every app reachable in a responsive grid; app clicks stay React-owned. */
(() => {
  'use strict';
  let scheduled = false, empty;
  function synchronize() {
    scheduled = false;
    const container = document.querySelector('.concept-material .material-standalone .morph-materials');
    if (!container) { empty.hidden = true; return; }
    if (!container.classList.contains('liveui-material-catalog')) {
      container.classList.add('liveui-material-catalog');
      // Scrolling the catalog must not trigger the old canvas drag or save positions.
      container.addEventListener('pointerdown', event => event.stopPropagation(), true);
    }
    const cards = [...container.querySelectorAll(':scope > .morph-material[data-app-id]')];
    for (const card of cards) {
      card.removeAttribute('data-liveui-page-hidden');
      card.inert = false;
    }
    empty.hidden = cards.length !== 0;
    document.body.classList.toggle('liveui-has-apps', cards.length > 0);
  }
  function mount() {
    if (new URLSearchParams(location.search).get('concept') !== 'material') return;
    empty = document.createElement('section');
    empty.className = 'liveui-catalog-empty'; empty.hidden = true;
    empty.setAttribute('aria-label', 'Your apps');
    const title = document.createElement('h2'); title.textContent = 'Your apps start here';
    const detail = document.createElement('p'); detail.textContent = 'Ask a question, start a task, or build an app.';
    const create = document.createElement('button'); create.type = 'button'; create.textContent = 'Get started';
    create.addEventListener('click', () => {
      document.querySelector('.frontend-prompt textarea')?.focus();
    });
    empty.append(title, detail, create); document.body.append(empty);
    new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(synchronize); } }).observe(document.body, { childList: true, subtree: true });
    synchronize();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
