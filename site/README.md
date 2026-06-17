# Site oficial da Sartec Papelaria

Esta pasta contém os arquivos do site institucional da Sartec Papelaria dentro do repositório `agente-triagem-crm-sartec`.

O repositório reúne três frentes do ecossistema digital da Sartec:

1. Painel de atendimento e CRM
2. Agente WhatsApp e APIs de suporte
3. Site institucional da Sartec Papelaria

A pasta `site/` deve ser tratada como código de site oficial dentro deste repositório. Ela não deve ser chamada de site legado, para evitar confusão com outros clones, pastas locais ou projetos Vercel usados durante a transição de domínio e deploy.

Antes de editar arquivos do site, confirme sempre:

```bash
pwd
git status
git remote -v
git branch --show-current
```

O diretório esperado deste repositório é:

```text
C:\Users\USER\Desktop\PROJETOS\SARTEC\PAINEL, AGENTE E SITE
```

Remote esperado:

```text
https://github.com/Suertesoy/agente-triagem-crm-sartec.git
```

Qualquer alteração no site deve ser feita com escopo claro, sem acessar pastas irmãs e sem misturar este repositório com clones locais de outros projetos.
