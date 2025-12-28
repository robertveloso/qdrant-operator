# E2E Test Suite

Este diretório contém os testes end-to-end (e2e) para o Qdrant Operator. Os testes são organizados em scripts bash modulares que validam diferentes propriedades e comportamentos do operator.

## 📋 Visão Geral

A estratégia de testes segue o princípio de **"1 cluster, 1 deploy, múltiplas invariantes"**:

- ✅ Um único cluster Kubernetes (K3s)
- ✅ Um único deploy do operator
- ✅ Múltiplos cenários de teste validando diferentes propriedades
- ✅ Execução sequencial e rápida

## 🧪 Cenários de Teste

### `00-setup.sh` - Setup Inicial

Cria o cluster Qdrant e a collection inicial necessária para os testes subsequentes.

**O que testa:**

- Criação do QdrantCluster
- Criação do StatefulSet pelo operator
- Rollout bem-sucedido do StatefulSet
- Criação da QdrantCollection

### `10-happy-path.sh` - Happy Path

Valida que o fluxo básico funciona: cluster criado, collection acessível e saudável.

**O que testa:**

- Collection está acessível via API do Qdrant
- Collection tem status "green" (saudável)
- Conectividade entre operator e cluster

### `20-drift.sh` - Detecção de Drift

Verifica que o operator detecta e corrige mudanças manuais nos recursos gerenciados.

**O que testa:**

- Operator detecta quando StatefulSet é modificado manualmente
- Operator restaura o estado desejado (reconciliação declarativa)
- Correção automática de drift

### `30-idempotency.sh` - Idempotência

Garante que reconciliações repetidas não causam rollouts desnecessários.

**O que testa:**

- Reconciliação não altera geração do StatefulSet sem mudanças no spec
- Operator é idempotente (mesma entrada = mesma saída)
- Evita rollouts infinitos

### `45-finalizer-under-load.sh` - Finalizer Sob Carga

Valida que o cleanup funciona corretamente quando o cluster é deletado durante atividade (cenário real de produção).

**O que testa:**

- Finalizer funciona mesmo com queries ativas no cluster
- Cleanup não é interrompido por atividade simultânea
- StatefulSet e pods são limpos mesmo sob carga
- Collection é limpa corretamente durante deleção sob carga

**Por que é importante:**

Este teste cobre o pior cenário real de operator - deleção durante atividade. Garante que o finalizer é robusto o suficiente para lidar com operações concorrentes.

### `40-finalizer.sh` - Finalizer e Cleanup

Valida que a deleção do cluster aciona o finalizer e limpa recursos corretamente.

**O que testa:**

- Finalizer é executado ao deletar QdrantCluster
- StatefulSet é removido
- Pods são limpos
- Recursos não ficam órfãos

### `50-leader-failover.sh` - Leader Failover (Opcional)

Testa o comportamento de alta disponibilidade quando o pod leader é deletado.

**O que testa:**

- Novo pod é criado após deleção do leader
- Novo leader é eleito automaticamente
- Operator continua funcionando após failover

**Nota:** Este teste está desabilitado por padrão no CI, mas pode ser habilitado se necessário.

## 🚀 Como Executar

### Localmente

```bash
# Certifique-se de ter um cluster Kubernetes rodando (k3s, kind, minikube)
# E o operator instalado

cd tests/e2e
chmod +x *.sh

# Executar todos os testes em sequência
./00-setup.sh
./10-happy-path.sh
./20-drift.sh
./30-idempotency.sh
./40-finalizer.sh
./45-finalizer-under-load.sh
# ./50-leader-failover.sh  # opcional
```

### No CI/CD

Os testes são executados automaticamente no GitHub Actions no job `integration-test`.

## 📁 Estrutura

```
tests/e2e/
├── README.md              # Esta documentação
├── utils.sh               # Funções utilitárias compartilhadas
├── 00-setup.sh            # Setup inicial
├── 10-happy-path.sh       # Happy path
├── 20-drift.sh            # Drift detection
├── 30-idempotency.sh      # Idempotência
├── 45-finalizer-under-load.sh  # Finalizer sob carga
├── 40-finalizer.sh        # Finalizer e cleanup
└── 50-leader-failover.sh  # Leader failover (opcional)
```

## 🔧 Utilitários (`utils.sh`)

O arquivo `utils.sh` contém funções compartilhadas:

- `log_info`, `log_warn`, `log_error`, `log_test` - Logging colorido
- `wait_for_resource` - Aguarda recurso ser criado
- `wait_for_deletion` - Aguarda recurso ser deletado
- `get_operator_pod` - Obtém nome do pod do operator
- `is_operator_leader` - Verifica se pod é leader

## ✅ Critérios de Sucesso

Um operator confiável deve passar em todos estes testes:

1. ✅ **Happy Path**: Operação básica funciona
2. ✅ **Drift Detection**: Reconciliação declarativa funciona
3. ✅ **Idempotência**: Não causa rollouts desnecessários
4. ✅ **Finalizer Sob Carga**: Cleanup funciona durante atividade
5. ✅ **Finalizers**: Cleanup adequado
6. ✅ **HA** (opcional): Failover funciona

> **Regra de Ouro**: Se seu operator passa nesses testes, ele é confiável em produção.

## 🐛 Debugging

Se um teste falhar:

1. Verifique os logs do operator:

   ```bash
   kubectl logs -n qdrant-operator deploy/qdrant-operator --tail=100
   ```

2. Verifique o status dos recursos:

   ```bash
   kubectl get qdrantcluster -A
   kubectl get statefulset -A
   kubectl get pods -A
   ```

3. Verifique eventos:

   ```bash
   kubectl get events -A --sort-by='.lastTimestamp' | tail -50
   ```

4. Execute o teste individualmente para isolar o problema:
   ```bash
   ./20-drift.sh  # exemplo
   ```

## 📝 Adicionando Novos Testes

Para adicionar um novo cenário de teste:

1. Crie um novo script `XX-nome-do-teste.sh`
2. Use o prefixo numérico para controlar a ordem de execução
3. Importe `utils.sh` para usar funções compartilhadas
4. Use as funções de logging para output consistente
5. Adicione o teste ao CI em `.github/workflows/ci.yml`

Exemplo:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Meu Teste: Descrição do que está sendo testado"

# Seu código de teste aqui

log_info "✅ Teste passou"
exit 0
```

## 🔄 Manutenção

- Mantenha os testes simples e focados em uma única propriedade
- Use timeouts apropriados (não muito curtos, não muito longos)
- Adicione logging útil para debugging
- Documente comportamentos não óbvios
