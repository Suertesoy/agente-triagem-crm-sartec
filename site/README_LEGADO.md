# ATENÇÃO — Pasta legada

A pasta `/site` contém uma versão antiga do site público da Sartec Papelaria.

## Site oficial atual

O site oficial da Sartec está em um repositório separado e isolado:

- **Repositório:** https://github.com/Suertesoy/sartecpapelaria
- **Deploy:** https://sartec.vercel.app

## O que NÃO fazer aqui

Não implementar nesta pasta:

- novas páginas ou seções do site público
- funcionalidades de leitura de lista escolar com IA
- novos estilos ou componentes visuais do site
- alterações de conteúdo ou textos do site

Essas implementações devem ser feitas no repositório oficial isolado (`Suertesoy/sartecpapelaria`).

## O que esta pasta ainda serve

Esta pasta existe porque o `vercel.json` deste monorepo ainda roteia o domínio principal para ela.
Enquanto essa rota não for removida ou migrada, os arquivos aqui precisam existir para não quebrar o deploy.

Qualquer alteração nesta pasta deve ser intencional, documentada e coordenada com a migração do `vercel.json`.
