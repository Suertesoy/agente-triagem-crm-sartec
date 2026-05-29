/* ======================================================
   SARTEC — Ferramenta de lista escolar (SIMULAÇÃO)
   Não chama IA real ainda. Tudo client-side com mock.
   ====================================================== */

// Lista mockada — simula o que a IA Vision retornaria.
// Cada item: nome canônico, emoji ilustrativo, qty padrão, observação.
const ITENS_MOCK = [
  { id: 'cad_universitario', nome: 'Caderno universitário 96 folhas', icon: '📓', qty: 4, obs: 'Capa dura' },
  { id: 'lapis_grafite', nome: 'Lápis grafite nº 2', icon: '✏️', qty: 6, obs: '' },
  { id: 'borracha_branca', nome: 'Borracha branca', icon: '🧽', qty: 2, obs: 'Sem capa' },
  { id: 'apontador', nome: 'Apontador com depósito', icon: '🔻', qty: 1, obs: '' },
  { id: 'caneta_azul', nome: 'Caneta esferográfica azul', icon: '🖊️', qty: 4, obs: '' },
  { id: 'caneta_preta', nome: 'Caneta esferográfica preta', icon: '🖋️', qty: 2, obs: '' },
  { id: 'caneta_vermelha', nome: 'Caneta esferográfica vermelha', icon: '🖍️', qty: 1, obs: '' },
  { id: 'lapis_cor', nome: 'Caixa de lápis de cor', icon: '🎨', qty: 1, obs: '24 cores' },
  { id: 'canetinha', nome: 'Caixa de canetinha hidrocor', icon: '🖌️', qty: 1, obs: '12 cores' },
  { id: 'estojo', nome: 'Estojo escolar', icon: '👜', qty: 1, obs: '' },
  { id: 'regua', nome: 'Régua transparente 30cm', icon: '📏', qty: 1, obs: '' },
  { id: 'esquadro_45', nome: 'Esquadro 45°', icon: '📐', qty: 1, obs: '' },
  { id: 'esquadro_60', nome: 'Esquadro 60°', icon: '📐', qty: 1, obs: '' },
  { id: 'tesoura', nome: 'Tesoura sem ponta', icon: '✂️', qty: 1, obs: '' },
  { id: 'cola_bastao', nome: 'Cola bastão', icon: '🩹', qty: 2, obs: '' },
  { id: 'pasta_polionda', nome: 'Pasta polionda', icon: '📁', qty: 2, obs: '40mm' },
  { id: 'tinta_guache', nome: 'Tinta guache', icon: '🎨', qty: 1, obs: '6 cores' },
  { id: 'pincel', nome: 'Pincel chato nº 8', icon: '🖌️', qty: 1, obs: '' },
  { id: 'massinha', nome: 'Massinha de modelar', icon: '🧱', qty: 1, obs: '' },
  { id: 'eva', nome: 'Folha de EVA', icon: '🟦', qty: 5, obs: 'Cores variadas' }
];

// Mensagens rotativas durante o "loading" (simula análise)
const LOADING_MSGS = [
  'Lendo sua lista de papel...',
  'Identificando os itens um por um...',
  'Buscando ilustrações pra você reconhecer...',
  'Quase lá, organizando tudo...'
];

// Estado da aplicação
let estado = {
  nome: '',
  whatsapp: '',
  itens: [], // cópia mutável dos itens
};

// =============== UTILITÁRIOS ===============
function trocarEstado(id) {
  document.querySelectorAll('.estado').forEach(el => el.classList.remove('ativo'));
  document.getElementById(id).classList.add('ativo');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function formatarTelefone(valor) {
  const limpo = valor.replace(/\D/g, '').slice(0, 11);
  if (limpo.length <= 10) {
    return limpo.replace(/(\d{2})(\d{0,4})(\d{0,4})/, (_, a, b, c) => {
      let r = '';
      if (a) r = `(${a}`;
      if (a.length === 2) r += ') ';
      if (b) r += b;
      if (c) r += `-${c}`;
      return r;
    });
  }
  return limpo.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
}

// =============== UPLOAD ===============
const uploadArea = document.getElementById('upload-area');
const arquivoInput = document.getElementById('arquivo');
const uploadLabel = document.getElementById('upload-label');
const formUpload = document.getElementById('form-upload');
const inputWhatsapp = document.getElementById('whatsapp');

inputWhatsapp.addEventListener('input', (e) => {
  e.target.value = formatarTelefone(e.target.value);
});

uploadArea.addEventListener('click', () => arquivoInput.click());
uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  if (e.dataTransfer.files.length) {
    arquivoInput.files = e.dataTransfer.files;
    onArquivoEscolhido();
  }
});
arquivoInput.addEventListener('change', onArquivoEscolhido);

function onArquivoEscolhido() {
  const f = arquivoInput.files?.[0];
  if (!f) return;
  uploadLabel.textContent = `✓ ${f.name}`;
}

formUpload.addEventListener('submit', (e) => {
  e.preventDefault();
  const nome = document.getElementById('nome').value.trim();
  const whatsapp = inputWhatsapp.value.trim();
  const arquivo = arquivoInput.files?.[0];

  if (!nome || !whatsapp) { alert('Preencha nome e WhatsApp.'); return; }
  if (!arquivo) { alert('Anexe a foto ou PDF da lista.'); return; }

  estado.nome = nome;
  estado.whatsapp = whatsapp;

  iniciarSimulacao();
});

// =============== LOADING SIMULADO ===============
function iniciarSimulacao() {
  trocarEstado('estado-loading');

  const hint = document.getElementById('loading-hint');
  let i = 0;
  hint.textContent = LOADING_MSGS[0];
  const interval = setInterval(() => {
    i = (i + 1) % LOADING_MSGS.length;
    hint.textContent = LOADING_MSGS[i];
  }, 700);

  // 2.8s simulando análise
  setTimeout(() => {
    clearInterval(interval);
    estado.itens = ITENS_MOCK.map(it => ({ ...it, incluso: true }));
    renderizarResultado();
    trocarEstado('estado-resultado');
  }, 2800);
}

// =============== RESULTADO ===============
const grid = document.getElementById('itens-grid');
const counterQuero = document.getElementById('counter-quero');
const counterTem = document.getElementById('counter-tem');
const resumoTotal = document.getElementById('resumo-total');
const btnEnviar = document.getElementById('btn-enviar');
const btnMarcarTodosTem = document.getElementById('btn-marcar-todos-tem');
const btnRecomecar = document.getElementById('btn-recomecar');

function renderizarResultado() {
  grid.innerHTML = estado.itens.map(it => `
    <div class="item-card ${it.incluso ? '' : 'excluido'}" data-id="${it.id}">
      <div class="item-img">${it.icon}</div>
      <h4>${it.nome}</h4>
      <div class="obs">${it.obs || '&nbsp;'}</div>
      <div class="item-controls">
        <div class="qty-control">
          <button class="qty-btn" data-acao="menos" aria-label="Diminuir">−</button>
          <span class="qty-num">${it.qty}</span>
          <button class="qty-btn" data-acao="mais" aria-label="Aumentar">+</button>
        </div>
        <button class="toggle-incluir ${it.incluso ? 'sim' : 'nao'}">
          ${it.incluso ? '✓ Quero' : '✗ Já tenho'}
        </button>
      </div>
    </div>
  `).join('');

  // Eventos de cada card
  grid.querySelectorAll('.item-card').forEach(card => {
    const id = card.dataset.id;
    const item = estado.itens.find(x => x.id === id);

    card.querySelector('.toggle-incluir').addEventListener('click', () => {
      item.incluso = !item.incluso;
      atualizarUI();
    });

    card.querySelectorAll('.qty-btn').forEach(b => {
      b.addEventListener('click', () => {
        if (b.dataset.acao === 'mais') item.qty += 1;
        else item.qty = Math.max(1, item.qty - 1);
        atualizarUI();
      });
    });
  });

  atualizarContadores();
  atualizarLinkEnviar();
}

function atualizarUI() {
  // Atualiza visualmente cada card sem recriar (mantém scroll)
  grid.querySelectorAll('.item-card').forEach(card => {
    const id = card.dataset.id;
    const item = estado.itens.find(x => x.id === id);
    card.classList.toggle('excluido', !item.incluso);
    card.querySelector('.qty-num').textContent = item.qty;
    const tg = card.querySelector('.toggle-incluir');
    tg.className = `toggle-incluir ${item.incluso ? 'sim' : 'nao'}`;
    tg.textContent = item.incluso ? '✓ Quero' : '✗ Já tenho';
  });
  atualizarContadores();
  atualizarLinkEnviar();
}

function atualizarContadores() {
  const inclusos = estado.itens.filter(x => x.incluso);
  const excluidos = estado.itens.filter(x => !x.incluso);
  counterQuero.textContent = `${inclusos.length} ${inclusos.length === 1 ? 'item' : 'itens'}`;
  counterTem.textContent = `${excluidos.length} já tenho`;
  resumoTotal.textContent = `${inclusos.length} ${inclusos.length === 1 ? 'item' : 'itens'}`;
}

function atualizarLinkEnviar() {
  const inclusos = estado.itens.filter(x => x.incluso);
  if (inclusos.length === 0) {
    btnEnviar.style.opacity = '0.5';
    btnEnviar.style.pointerEvents = 'none';
    btnEnviar.removeAttribute('href');
    return;
  }
  btnEnviar.style.opacity = '';
  btnEnviar.style.pointerEvents = '';

  const linhas = inclusos.map(x => `✅ ${x.qty}x ${x.nome}${x.obs ? ' (' + x.obs + ')' : ''}`).join('\n');
  const mensagem =
`Olá, Sartec! Sou *${estado.nome}*.

Montei minha lista escolar pelo site:

${linhas}

Aguardo o orçamento. Obrigado!

— Enviado pela ferramenta do site`;

  btnEnviar.href = montarWpp(SARTEC.WPP_PRINCIPAL, mensagem);
}

btnMarcarTodosTem.addEventListener('click', () => {
  const algumIncluso = estado.itens.some(x => x.incluso);
  estado.itens.forEach(x => x.incluso = !algumIncluso);
  atualizarUI();
  btnMarcarTodosTem.textContent = algumIncluso
    ? 'Marcar todos como "Quero"'
    : 'Marcar todos como "Já tenho"';
});

btnRecomecar.addEventListener('click', () => {
  if (confirm('Recomeçar do zero? Sua seleção atual será perdida.')) {
    formUpload.reset();
    uploadLabel.textContent = 'Clique ou arraste sua lista aqui';
    trocarEstado('estado-upload');
  }
});
