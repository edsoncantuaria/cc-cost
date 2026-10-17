<div align="center">

# cc-cost

**O quanto sua sessão do Claude Code está gastando de verdade — ao vivo, acima do prompt.**

Tokens, contexto e as **janelas de 5h / 7d** da assinatura, não dólares de API.

[![Claude Code](https://img.shields.io/badge/Claude_Code-2.1.287%2B-d97757)](https://claude.com/claude-code)
[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue)](LICENSE)
[![Sem telemetria](https://img.shields.io/badge/rede-nenhuma-success)](#privacidade)

[English](README.md)

![Faixa do cc-cost acima do prompt do Claude Code](docs/band.png)

</div>

---

## Instalação

No prompt de uma sessão do Claude Code:

```
/plugin install cc-cost --marketplace edsoncantuaria/cc-cost
```

Responda `y` para adicionar o marketplace e escolha o escopo. A faixa aparece no próximo turno.

## Lendo a faixa

| Trecho | Significado |
| --- | --- |
| `19k tokens` | Tokens novos da sessão: entrada + escrita de cache + saída |
| `↑ 19k  ↓ 30` | Divisão entre entrada e saída |
| `cache 83%` | Parcela da entrada servida por leitura de cache (fica fora do total, pois reenvia o mesmo contexto a cada requisição) |
| `hoje 156k` | Total do dia somando todas as sessões, guardado localmente por 7 dias |
| `5h 9%  7d 10%` | Janelas de uso da assinatura (e limite de gasto, se houver), verde → amarelo → vermelho |
| `ctx 111k/1,0M` | Contexto atual contra a janela do autocompact; fica amarelo e depois vermelho antes dele |
| `▁▃▅█` | Sparkline de tokens novos por turno |
| `[ compact ]` | Compactação com uma tecla (`c`), escolhendo o modo mais barato |
| subagentes | Quantos rodam e o maior contexto entre eles; os tokens entram no dia, não na sessão |

### Compactação inteligente

O botão **compact** escolhe o que custa menos:

- **`/compact micro`** quando leituras de arquivo passam de 40% do contexto (precisa do plugin micro-compaction);
- senão, o **`/compact`** nativo com um resumo focado.

Quando o contexto fica vermelho, um toast avisa qual modo o botão vai usar e quanto ele libera.

## Por que não o ccusage?

O ccusage estima o **custo de API em dólar** a partir de logs passados. Na assinatura Pro/Max esse não é o valor que você paga — o que importa é a **janela de 5h, ao vivo**. O cc-cost mostra isso dentro da sessão.

## Requisitos

- Claude Code **2.1.287+** com mods (function hooks, acesso antecipado).
- Opcional: o plugin micro-compaction para o modo `micro`.

## Desenvolvimento

```bash
git clone https://github.com/edsoncantuaria/cc-cost ~/.claude/mods/cc-cost
claude plugin validate ~/.claude/mods/cc-cost
claude plugin test ~/.claude/mods/cc-cost
claude --plugin-dir ~/.claude/mods/cc-cost
```

Para carregar o clone em toda sessão, defina `CLAUDE_CODE_PLUGIN_DIRS` com a pasta no bloco `env` de `~/.claude/settings.json` e reinicie o Claude Code. Só copiar a pasta não carrega o mod. Não combine com a instalação pelo marketplace, senão a faixa aparece duas vezes.

## Privacidade

Sem rede e sem telemetria. Só lê o uso da sessão que o Claude Code fornece e guarda contadores diários no store local do mod.

## Licença

[MIT](LICENSE)
