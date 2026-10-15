// Perfis de atendente (painel/index.html): Larissa é atendente comum — aparece
// no seletor, pode ser selecionada, e NÃO tem acesso à aba de métricas
// (exclusiva de Lucas e Denise).
//
// painel/index.html não é módulo ES: as funções são extraídas por regex do
// próprio arquivo e avaliadas isoladamente (mesmo padrão de
// tests/composer-send-button.test.js).
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(HERE, "..", "painel", "index.html"), "utf8");

function extract(regex, label) {
  const match = html.match(regex);
  if (!match) throw new Error(`${label} não encontrado em painel/index.html — verifique se foi renomeado/movido`);
  return match[0];
}

const profilesSrc   = extract(/const ATTENDANT_PROFILES = \[[\s\S]*?\n\];/, "ATTENDANT_PROFILES");
const getCurrentSrc = extract(/function getCurrentAttendant\([\s\S]*?\n\}\r?\n/, "getCurrentAttendant()");
const accessSrc     = extract(/function checkMetricsAccess\([\s\S]*?\n\}\r?\n/, "checkMetricsAccess()");
const setSrc        = extract(/function setAttendant\([\s\S]*?\n\}\r?\n/, "setAttendant()");
const fabColorsSrc  = extract(/function getAttendantFabColors\([\s\S]*?\n\}\r?\n/, "getAttendantFabColors()");

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
const calls = { badge: null, picker: 0, notif: 0, metricsTab: 0 };

const api = new Function(
  "localStorage", "calls",
  `${profilesSrc}
   ${getCurrentSrc}
   ${accessSrc}
   ${fabColorsSrc}
   function renderAttendantBadge(p) { calls.badge = p; }
   function closeAttendantPicker() { calls.picker++; }
   function requestNotificationPermission() { calls.notif++; }
   function updateMetricsTabVisibility() { calls.metricsTab++; }
   ${setSrc}
   return { ATTENDANT_PROFILES, getCurrentAttendant, checkMetricsAccess, setAttendant, getAttendantFabColors };`
)(localStorage, calls);

describe("perfis de atendente", () => {
  beforeEach(() => { store.clear(); calls.badge = null; });

  test("Larissa aparece na seleção com avatar e cor próprios", () => {
    const larissa = api.ATTENDANT_PROFILES.find(p => p.id === "larissa");
    assert.ok(larissa, "perfil larissa ausente");
    assert.equal(larissa.name, "Larissa");
    assert.equal(larissa.initials, "LA");
    const others = api.ATTENDANT_PROFILES.filter(p => p.id !== "larissa");
    assert.ok(!others.some(p => p.color === larissa.color), "cor deve ser exclusiva");
    assert.notEqual(api.getAttendantFabColors(larissa.color), api.getAttendantFabColors("inexistente"));
    assert.equal(api.getAttendantFabColors(larissa.color).bg, "#fee2e2");
  });

  test("ids são únicos e perfis existentes mantêm seus identificadores", () => {
    const ids = api.ATTENDANT_PROFILES.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ["ana_paula", "ana_flores", "pedro", "eli", "ilsa", "denise", "lucas"]) {
      assert.ok(ids.includes(id), `perfil ${id} desapareceu`);
    }
  });

  test("Larissa pode ser selecionada e vira o atendente ativo", () => {
    api.setAttendant("larissa");
    const current = api.getCurrentAttendant();
    assert.equal(current.id, "larissa");
    assert.equal(current.name, "Larissa");
    assert.equal(calls.badge.id, "larissa");
  });

  test("Larissa não acessa métricas; Lucas e Denise continuam acessando", () => {
    api.setAttendant("larissa");
    assert.equal(api.checkMetricsAccess(), false);
    for (const id of ["lucas", "denise"]) {
      api.setAttendant(id);
      assert.equal(api.checkMetricsAccess(), true, id);
    }
    for (const id of ["ana_paula", "ana_flores", "pedro", "eli", "ilsa", "larissa"]) {
      api.setAttendant(id);
      assert.equal(api.checkMetricsAccess(), false, id);
    }
  });
});
