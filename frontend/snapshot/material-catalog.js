/* Keep every app reachable in a responsive grid; app clicks stay React-owned. */
(() => {
  'use strict';
  let scheduled = false, empty, heading, count, search;
  let openApps = new Set();
  function synchronize() {
    scheduled = false;
    const container = document.querySelector('.concept-material .material-standalone .morph-materials');
    if (!container) { empty.hidden = true; heading.hidden = true; return; }
    if (!container.classList.contains('liveui-material-catalog')) {
      container.classList.add('liveui-material-catalog');
      // Scrolling the catalog must not trigger the old canvas drag or save positions.
      container.addEventListener('pointerdown', event => event.stopPropagation(), true);
    }
    const cards = [...container.querySelectorAll(':scope > .morph-material[data-app-id]')];
    const currentOpen = new Set([...document.querySelectorAll('.app-sheet[data-app-id]')].map(el=>el.dataset.appId));
    for(const appId of openApps)if(!currentOpen.has(appId))window.dispatchEvent(new CustomEvent('liveui:gallery-refresh',{detail:{appId}}));
    openApps=currentOpen;
    for (const card of cards) {
      card.removeAttribute('data-liveui-page-hidden');
      card.inert = false;
      const filtered=!!search.value.trim()&&!String(card.dataset.searchText||card.textContent).toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase());
      card.toggleAttribute('data-gallery-filtered',filtered);
    }
    const total=String(cards.length)+' 个';if(count.textContent!==total)count.textContent=total;
    heading.hidden=cards.length===0||!!document.querySelector('.app-sheet');
    empty.hidden = cards.length !== 0;
    document.body.classList.toggle('liveui-has-apps', cards.length > 0);
  }
  function mount() {
    heading=document.createElement('header');heading.className='liveui-catalog-heading';
    const name=document.createElement('h2');name.textContent='我的应用';count=document.createElement('span');count.className='catalog-count';name.append(count);
    search=document.createElement('input');search.type='search';search.placeholder='搜索应用';search.setAttribute('aria-label','搜索应用');search.addEventListener('input',synchronize);
    heading.append(name,search);document.body.append(heading);
    empty = document.createElement('section');
    empty.className = 'liveui-catalog-empty'; empty.hidden = true;
    empty.setAttribute('aria-label', 'Your apps');
    const title = document.createElement('h2'); title.textContent = 'Your apps start here';
    const detail = document.createElement('p'); detail.textContent = 'Ask a question, start a task, or build an app.';
    const starters = document.createElement('div'); starters.className = 'liveui-starters';
    for (const [label, prompt] of [
      ['Track expenses', 'Build a personal expense tracker with categories, a monthly budget, and CSV export.'],
      ['Plan my week', 'Build a weekly planner with tasks, priorities, and a simple calendar view.'],
      ['Save reading notes', 'Build a reading list with books, progress, and searchable notes.'],
      ['Start a habit', 'Build a daily habit tracker with check-ins and weekly progress.']
    ]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', () => {
        const field = document.querySelector('.frontend-prompt textarea');
        if (!field) return;
        field.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, prompt);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      starters.append(button);
    }
    empty.append(title, detail, starters); document.body.append(empty);
    new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(synchronize); } }).observe(document.body, { childList: true, subtree: true });
    synchronize();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
