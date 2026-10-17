# cc-cost

[English](README.md)

Mod minimalista para o Claude Code que mostra uma faixa acima do prompt com o quanto a sessão está gastando de verdade das **janelas de uso da assinatura** (5h / 7d), e não dólares de API.

```
243k tokens  ↑ 202k  ↓ 41k  cache 83%  hoje 243k  5h 62%  ▁▃▅█
```

## O que mostra
- **Tokens novos da sessão** (entrada + escrita de cache + saída). A leitura de cache fica de fora, porque é o mesmo contexto reenviado a cada requisição e contaria a conversa várias vezes; ela aparece como percentual de cache.
- **Total do dia**, somando todas as sessões (guardado localmente por 7 dias).
- **Limites de uso** do Claude Code: 5h, 7d e limite de gasto, com cor conforme sobem.
- **Contexto atual** contra a janela do autocompact, ficando amarelo e depois vermelho antes do autocompact.
- **Sparkline** de tokens novos por turno.
- **Subagentes rodando**: quantos e o maior contexto entre eles, com cor conforme a janela de compactação. Os tokens dos subagentes entram no total do dia, mas ficam fora do total da sessão e das barras por turno.
- **Botão de compactar** que escolhe o mais barato: `/compact micro` (precisa do plugin micro-compaction) quando leituras de arquivo passam de 40% do contexto; senão, o `/compact` nativo com um resumo focado.

## Por que não o ccusage?
O ccusage estima o custo de API em dólar a partir dos logs passados. Na assinatura Pro/Max esse valor não é o que você paga; o que importa é a janela de 5h, ao vivo. O cc-cost mostra isso dentro da sessão.

## Requisitos
- Claude Code **2.1.287+** com mods (function hooks, acesso antecipado).
- Opcional: o plugin micro-compaction para o modo `micro`.

## Instalação
No prompt de uma sessão do Claude Code:
```
/plugin install cc-cost --marketplace edsoncantuaria/cc-cost
```
Responda `y` para adicionar o marketplace e escolha o escopo.

### A partir de um clone local (desenvolvimento)
```bash
git clone https://github.com/edsoncantuaria/cc-cost ~/.claude/mods/cc-cost
claude plugin validate ~/.claude/mods/cc-cost
claude --plugin-dir ~/.claude/mods/cc-cost
```
Para carregar em toda sessão, defina `CLAUDE_CODE_PLUGIN_DIRS` com a pasta no bloco `env` de `~/.claude/settings.json` e reinicie o Claude Code. Só copiar a pasta (sem um desses) não carrega o mod.

## Testes
```bash
claude plugin test ~/.claude/mods/cc-cost
```

## Privacidade
Sem rede e sem telemetria. Só lê o uso da sessão que o Claude Code fornece e guarda contadores diários no store local do mod.

## Licença
MIT
