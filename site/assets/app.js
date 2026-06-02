/* ======================================================
   SARTEC — JS comum (header, footer, FAB)
   Site sempre em light mode — dark mode removido.
   ====================================================== */

window.SARTEC = {
  WPP_PRINCIPAL: '5512981594959',
  WPP_COPIAS:    '5512981594959',
  ENDERECO: 'Av. Andrômeda, 1805 — Jardim Satélite, São José dos Campos/SP',
  CEP: '12230-000',
  CNPJ: '06.241.041/0001-56',
  HORARIO:  'Seg a Sex: 8h às 18h • Sáb: 8h às 13h',
  TELEFONE_DISPLAY: '(12) 98159-4959',
  EMAIL: 'sartecpapelaria@uol.com.br'
};

function montarWpp(numero, mensagem) {
  const texto = mensagem ? '?text=' + encodeURIComponent(mensagem) : '';
  return `https://wa.me/${numero}${texto}`;
}

/* =========================================================
   HEADER
   ========================================================= */
let _menuListenersAdded = false;

function renderHeader(active) {
  const lk = (slug) => active === slug ? 'class="active"' : '';
  const wppSVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>`;

  const html = `
    <header class="site-header">
      <div class="container">
        <a href="index.html" class="brand">
          <img src="assets/logo-sartec-header.png" alt="Sartec Papelaria" />
        </a>
        <nav class="main-nav" id="main-nav">
          <a href="index.html" ${lk('home')}>Início</a>
          <a href="produtos.html" ${lk('produtos')}>Produtos</a>
          <a href="lista-escolar.html" ${lk('lista')}>Lista Escolar</a>
          <a href="empresas.html" ${lk('empresas')}>Empresas</a>
          <a href="escolas.html" ${lk('escolas')}>Escolas Parceiras</a>
          <a href="copias.html" ${lk('copias')}>Cópias e Impressão</a>
        </nav>
        <div class="header-actions">
          <a href="${montarWpp(SARTEC.WPP_PRINCIPAL, 'Olá! Vim pelo site da Sartec.')}"
             target="_blank" rel="noopener" class="btn-wpp-header">
            ${wppSVG}<span>WhatsApp</span>
          </a>
          <button class="menu-toggle" id="menu-toggle" onclick="toggleMenu()" aria-label="Menu">
            <svg width="22" height="27" viewBox="0 0 24 29" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="3" y1="6" x2="21" y2="6"/>
              <line x1="3" y1="12" x2="21" y2="12"/>
              <line x1="3" y1="18" x2="21" y2="18"/>
              <polyline points="9,22 12,26 15,22" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </header>
  `;
  document.getElementById('header-mount')?.insertAdjacentHTML('afterbegin', html);

  document.querySelectorAll('#main-nav a').forEach(a =>
    a.addEventListener('click', closeMenu)
  );

  if (!_menuListenersAdded) {
    document.addEventListener('click', e => {
      if (!document.querySelector('.site-header')?.contains(e.target)) closeMenu();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeMenu();
    });
    _menuListenersAdded = true;
  }
}

function closeMenu() {
  document.getElementById('main-nav')?.classList.remove('open');
}

function toggleMenu() {
  const nav = document.getElementById('main-nav');
  if (nav) nav.classList.toggle('open');
}

/* =========================================================
   FAIXA DE ESCOLAS (MARQUEE)
   ========================================================= */
function renderEscolasFaixa() {
  const mount = document.getElementById('escolas-faixa-mount');
  if (!mount) return;

  const escolas = [
    { badge: 'SM', nome: 'Colégio Santa Maria', desc: '20% OFF' },
    { badge: 'DB', nome: 'Escola Dom Bosco', desc: '20% OFF' },
    { badge: 'CO', nome: 'Colégio Objetivo', desc: '20% OFF' },
    { badge: 'SP', nome: 'Instituto São Paulo', desc: '20% OFF' },
    { badge: '★', nome: 'Parceria exclusiva para alunos', desc: 'Saiba mais →' },
  ];

  const pills = escolas.map(e => `
    <div class="escola-pill">
      <div class="badge">${e.badge}</div>
      <span>${e.nome}</span>
      <span class="desc">${e.desc}</span>
    </div>
  `).join('');

  mount.innerHTML = `
    <div class="escolas-faixa">
      <div class="faixa-track">
        ${pills}${pills}
      </div>
    </div>
  `;
}

/* =========================================================
   FOOTER
   ========================================================= */
function renderFooter() {
  const html = `
    <footer class="site-footer">
      <div class="container">
        <div class="footer-grid">
          <div class="footer-brand">
            <img src="assets/logo-sartec.png" alt="Sartec Papelaria" />
            <p>Papelaria, informática, cópias e impressão. Atendimento personalizado e tudo organizado pra você.</p>
          </div>
          <div class="footer-col">
            <h4>Serviços</h4>
            <a href="produtos.html">Produtos</a>
            <a href="lista-escolar.html">Lista Escolar</a>
            <a href="copias.html">Cópias e Impressão</a>
            <a href="empresas.html">Empresas</a>
            <a href="escolas.html">Escolas Parceiras</a>
          </div>
          <div class="footer-col">
            <h4>Contato</h4>
            <p>${SARTEC.TELEFONE_DISPLAY}</p>
            <p>${SARTEC.EMAIL}</p>
            <p>CNPJ: ${SARTEC.CNPJ}</p>
          </div>
          <div class="footer-col">
            <h4>Visite a loja</h4>
            <p>${SARTEC.ENDERECO}</p>
            <p>CEP: ${SARTEC.CEP}</p>
            <p style="font-size:.85rem;opacity:.85">${SARTEC.HORARIO}</p>
          </div>
        </div>
        <div class="footer-bottom">
          © 2026 Sartec Papelaria e Informática. Todos os direitos reservados.
          <div class="footer-digital">Tecnologia de atendimento desenvolvida por <a href="#" target="_blank" rel="noopener" class="footer-digital-link"><!-- TODO: substituir pela URL final da Sartec Digital -->Sartec Digital</a>.</div>
        </div>
      </div>
    </footer>
  `;
  document.getElementById('footer-mount')?.insertAdjacentHTML('beforeend', html);
}

/* =========================================================
   FAB
   ========================================================= */
function renderFab(modo) {
  const isCopias = modo === 'copias';
  const numero = isCopias ? SARTEC.WPP_COPIAS : SARTEC.WPP_PRINCIPAL;
  const msg = isCopias
    ? 'Olá! Quero falar com o setor de cópias e impressão.'
    : 'Olá! Vim pelo site da Sartec.';
  const cls = isCopias ? 'fab-wpp copias' : 'fab-wpp';
  const label = isCopias ? 'WhatsApp Cópias' : 'Falar no WhatsApp';
  const html = `
    <a href="${montarWpp(numero, msg)}" target="_blank" rel="noopener" class="${cls}" aria-label="${label}">
      <svg class="ico" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
      </svg>
      <span class="label">${label}</span>
    </a>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
}

/* =========================================================
   PAGE TRANSITIONS (page-transition)
   ========================================================= */
function initPageTransitions() {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      document.body.classList.remove('is-leaving');
    }
  });

  document.addEventListener('click', (e) => {
    const anchor = e.target.closest('a');
    if (!anchor) return;

    const href = anchor.getAttribute('href');
    const target = anchor.getAttribute('target');

    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    if (!href || 
        target === '_blank' || 
        e.defaultPrevented ||
        href.startsWith('#') || 
        href.startsWith('mailto:') || 
        href.startsWith('tel:') || 
        href.startsWith('javascript:') || 
        href.includes('wa.me') ||
        (href.includes('//') && !href.includes(window.location.host))) {
      return;
    }

    e.preventDefault();
    document.body.classList.add('is-leaving');

    setTimeout(() => {
      window.location.href = href;
    }, 150);
  });
}

/* =========================================================
   INIT
   ========================================================= */
window.SartecInit = function ({ active, fab }) {
  document.addEventListener('DOMContentLoaded', () => {
    renderHeader(active);
    renderEscolasFaixa();
    renderFooter();
    renderFab(fab || 'principal');
    initPageTransitions();
  });
};
