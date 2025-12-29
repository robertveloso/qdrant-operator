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

### `40-finalizer.sh` - Finalizer e Cleanup

Valida que a deleção do cluster aciona o finalizer e limpa recursos corretamente.

**O que testa:**

- Finalizer é executado ao deletar QdrantCluster
- StatefulSet é removido
- Pods são limpos
- Recursos não ficam órfãos

### `41-finalizer-under-load.sh` - Finalizer Sob Carga

Valida que o cleanup funciona corretamente quando o cluster é deletado durante atividade (cenário real de produção).

**O que testa:**

- Finalizer funciona mesmo com queries ativas no cluster
- Cleanup não é interrompido por atividade simultânea
- StatefulSet e pods são limpos mesmo sob carga
- Collection é limpa corretamente durante deleção sob carga

**Por que é importante:**

Este teste cobre o pior cenário real de operator - deleção durante atividade. Garante que o finalizer é robusto o suficiente para lidar com operações concorrentes.

**Nota:** Este teste cria um novo cluster e collection, pois o teste anterior (`40-finalizer.sh`) deleta os recursos.

### `50-leader-failover.sh` - Leader Failover

Testa o comportamento de alta disponibilidade quando o pod leader é deletado.

**O que testa:**

- Novo pod é criado após deleção do leader
- Novo leader é eleito automaticamente
- Operator continua funcionando após failover

### `60-leader-failover-during-reconcile.sh` - Leader Failover Durante Reconcile

Valida comportamento de alta disponibilidade quando o leader é deletado durante reconciliação ativa.

**O que testa:**

- Novo líder é eleito rapidamente durante reconcile ativo
- Reconcile é completado corretamente após failover
- StatefulSet não fica em estado inconsistente
- Nenhum recurso órfão é criado
- Não há split-brain ou apply parcial

**Por que é importante:**

Este é o cenário mais perigoso de failover - quando o leader morre no meio de uma operação. Garante que `activeReconciles` funciona e que não há corrupção de estado.

### `65-operator-crash-loop.sh` - Operator Crash Loop Durante Reconcile

Valida que o operator lida graciosamente com crashes repetidos durante reconciliação ativa.

**O que testa:**

- Operator não cria recursos duplicados após crashes repetidos
- Estado converge corretamente mesmo após múltiplos crashes
- Não há split-brain ou estado inconsistente
- Operator continua funcionando após crash-loop
- Nenhum recurso órfão é criado

**Cenário:**

1. Cria cluster e aguarda estar healthy
2. Inicia reconciliação longa (atualiza image para forçar rollout)
3. Deleta pod do operator **4 vezes seguidas** durante reconcile
4. Verifica que:
   - Apenas 1 StatefulSet existe (sem duplicatas)
   - Apenas 1 pod do cluster existe (sem órfãos)
   - Estado converge para estado correto
   - Não há erros de split-brain nos logs
   - Operator ainda pode reconciliar após crashes

**Por que é importante:**

Este teste separa operators **bons** de **ótimos**. Em produção, operators podem entrar em crash-loop devido a:

- Bugs no código
- Problemas de memória (OOMKilled)
- Problemas de rede temporários
- Problemas com dependências externas

Um operator robusto deve:

- ✅ Não criar recursos duplicados mesmo após múltiplos crashes
- ✅ Convergir para estado correto eventualmente
- ✅ Não entrar em split-brain
- ✅ Continuar funcionando após crash-loop

**Diferenciação:**

- `50-leader-failover.sh`: Testa 1 crash simples
- `60-leader-failover-during-reconcile.sh`: Testa 1 crash durante reconcile
- `65-operator-crash-loop.sh`: Testa **múltiplos crashes consecutivos** durante reconcile (mais rigoroso)

### `70-invalid-spec.sh` - Spec Inválida

Valida que o operator lida graciosamente com specs inválidas sem crashar.

**O que testa:**

- Operator não crasha com spec inválida
- Status do CR fica `Error` com mensagem clara
- Nenhum recurso é criado com spec inválida
- Mensagem de erro é informativa

**O que valida:**

- `replicas < 1` → erro
- `image` vazio → erro
- `vectorSize < 1` (collections) → erro

**Por que é importante:**

Diferencia operator maduro de "controller frágil". Em produção, usuários podem criar specs inválidas acidentalmente.

### `80-periodic-reconcile-no-events.sh` - Reconciliação Periódica Sem Eventos

Valida que a reconciliação periódica funciona mesmo quando eventos de watch são perdidos.

**O que testa:**

- Reconciliação periódica detecta drift sem eventos de watch
- Estado é restaurado mesmo após perda de eventos
- Operator não depende cegamente de watch

**Cenário:**

1. Cria cluster
2. Escala StatefulSet manualmente (drift)
3. Aguarda reconciliação periódica (30s)
4. Verifica que estado é restaurado

**Por que é importante:**

Garante que o safety net funciona. Em produção, watches podem ser perdidos temporariamente (API server restart, network issues).

### `90-spec-update-rollout.sh` - Update de Spec com Rollout Controlado

Valida que updates de spec geram rollouts controlados e status correto.

**O que testa:**

- Rollout é iniciado quando spec muda
- Status permanece `Pending` ou `OperationInProgress` durante rollout
- Status muda para `Running` ou `Healthy` apenas quando pods estão prontos
- `Healthy` indica que todos os replicas estão prontos e disponíveis
- Não há rollouts infinitos
- Geração do StatefulSet aumenta (indica rollout)

**Por que é importante:**

Garante que updates são seguros e controlados. Valida que hash comparison funciona e que status reflete estado real.

### `100-delete-partial-cleanup.sh` - Delete com Cleanup Parcial

Valida que cleanup é idempotente quando recursos já foram parcialmente removidos.

**O que testa:**

- Finalizer não falha quando StatefulSet já foi deletado
- Cleanup é idempotente (pode ser chamado múltiplas vezes)
- Operator não assume estado perfeito
- CR é deletado com sucesso mesmo com recursos parcialmente removidos

**Cenário:**

1. Cria cluster
2. Deleta StatefulSet manualmente (simula falha parcial)
3. Deleta CR (aciona finalizer)
4. Verifica que finalizer lida graciosamente

**Por que é importante:**

Em produção, recursos podem ser deletados manualmente ou por outros processos. O operator deve lidar com isso graciosamente.

### `110-pvc-auto-resize.sh` - PVC Auto Resize

Valida que PVCs são expandidos automaticamente quando `spec.persistence.size` aumenta.

**O que testa:**

- PVC é criado com tamanho inicial correto
- Quando spec.persistence.size aumenta, PVC é expandido automaticamente
- Operator detecta mudança e aplica expansão
- PVC entra em estado de Resizing (se suportado pelo storage provider)

**Por que é importante:**

Garante que usuários podem aumentar storage sem intervenção manual. Valida que resize automático funciona corretamente.

**Nota**: Requer storage provider que suporte volume expansion.

### `120-volumesnapshot-manual.sh` - VolumeSnapshot Manual

Valida criação manual de VolumeSnapshots via `createNow: true`.

**O que testa:**

- VolumeSnapshot é criado quando `createNow: true`
- Snapshots são criados para todos os PVCs do cluster
- Snapshots têm labels corretos (clustername, component)
- Snapshot fica pronto (readyToUse) quando suportado

**Por que é importante:**

Valida backup nativo de PVCs via CSI snapshots. Garante que snapshots podem ser criados sob demanda.

**Nota**: Teste é pulado automaticamente se VolumeSnapshot API não estiver disponível (CSI snapshot feature não instalado).

### `130-volumesnapshot-scheduled.sh` - VolumeSnapshot Scheduled

Valida criação agendada de VolumeSnapshots via CronJob.

**O que testa:**

- CronJob é criado quando `schedule` é configurado
- CronJob executa e cria snapshots
- Retention policy funciona (mantém apenas N snapshots)
- Snapshots antigos são deletados automaticamente

**Por que é importante:**

Garante backups automáticos e regulares. Valida que retention policy previne acúmulo de snapshots.

**Nota**: Teste é pulado automaticamente se VolumeSnapshot API não estiver disponível (CSI snapshot feature não instalado).

### `140-api-collections.sh` - API Collections

Valida criação e listagem de collections via API REST.

**O que testa:**

- Criar collection via API (`POST /api/v1/collections`)
- Listar collections via API (`GET /api/v1/collections`)
- Obter collection específica (`GET /api/v1/collections/{name}`)
- Criar collection usando template
- Validação de requests (campos obrigatórios)
- **Concorrência**: Duas requisições simultâneas criando a mesma collection
  - Uma deve retornar 201 (sucesso)
  - Outra deve retornar 409 (Conflict)
  - Apenas um CRD deve ser criado (sem duplicatas)
  - Valida idempotência, locking lógico e consistência

**Por que é importante:**

Garante que a API REST funciona corretamente e cria CRDs que são reconciliados pelo operator. O teste de concorrência valida que a API lida corretamente com requisições simultâneas, prevenindo criação de recursos duplicados e garantindo consistência mesmo sob carga concorrente.

### `150-api-restore.sh` - API Restore

Valida operações de restore via API REST.

**O que testa:**

- Criar restore via API (`POST /api/v1/restore/collections/{name}`)
- Verificar status de restore (`GET /api/v1/restore/collections/{name}`)
- Restore com dados dummy (insere dados, faz backup, restaura)

**Por que é importante:**

Garante que restore via API cria CRDs corretos e que a reconciliação funciona.

**Nota**: Requer configuração de S3 para backups completos. Teste é parcialmente executado mesmo sem S3 configurado.

### `160-api-authentication.sh` - API Authentication

Valida autenticação da API REST.

**O que testa:**

- Request sem token (deve falhar em produção, permitir em dev)
- Request com token inválido (deve retornar 401)
- Request com token válido (deve retornar 200)
- Formatos de header (`Bearer` e `Token`)

**Por que é importante:**

Garante que autenticação funciona corretamente e protege a API.

### `170-api-templates.sh` - API Templates

Valida criação e uso de templates via API e CRD.

**O que testa:**

- Criar template via API (`POST /api/v1/templates`)
- Listar templates via API (`GET /api/v1/templates`)
- Obter template específico (`GET /api/v1/templates/{name}`)
- Criar collection usando template
- Criar template via kubectl (CRD direto) e acessar via API
- Validação de templates (nome obrigatório, formato)

**Por que é importante:**

Garante que templates funcionam tanto via API quanto via CRD direto, e que collections criadas com templates herdam as configurações corretas.

### `180-api-integration.sh` - API Integration E2E

Teste end-to-end completo validando o fluxo: API → CRD → Reconciler → Qdrant.

**O que testa:**

- Criar template via API
- Criar collection via API usando template
- Verificar que CRD foi criado
- Verificar que reconciler criou collection no Qdrant
- Inserir dados dummy na collection
- Verificar que dados estão acessíveis
- Verificar que collection aparece na API
- Validar fluxo completo: API → CRD → Reconciler → Qdrant → API

**Por que é importante:**

Este é o teste mais importante - valida que toda a cadeia funciona: API cria CRD, reconciler processa CRD, Qdrant recebe collection, e API reflete o estado final. Garante que não há gaps na integração.

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
./41-finalizer-under-load.sh
./50-leader-failover.sh
./60-leader-failover-during-reconcile.sh
./65-operator-crash-loop.sh
./70-invalid-spec.sh
./80-periodic-reconcile-no-events.sh
./90-spec-update-rollout.sh
./100-delete-partial-cleanup.sh
./110-pvc-auto-resize.sh
./120-volumesnapshot-manual.sh
./130-volumesnapshot-scheduled.sh
./140-api-collections.sh
./150-api-restore.sh
./160-api-authentication.sh
./170-api-templates.sh
./180-api-integration.sh
```

### No CI/CD

Os testes são executados automaticamente no GitHub Actions no job `integration-test`.

## 📁 Estrutura

```
tests/e2e/
├── README.md                        # Esta documentação
├── utils.sh                         # Funções utilitárias compartilhadas
├── 00-setup.sh                      # Setup inicial
├── 10-happy-path.sh                 # Happy path
├── 20-drift.sh                      # Drift detection
├── 30-idempotency.sh                # Idempotência
├── 40-finalizer.sh                  # Finalizer e cleanup
├── 41-finalizer-under-load.sh       # Finalizer sob carga
├── 50-leader-failover.sh            # Leader failover
├── 60-leader-failover-during-reconcile.sh  # Leader failover durante reconcile
├── 65-operator-crash-loop.sh        # Operator crash-loop durante reconcile (múltiplos crashes)
├── 70-invalid-spec.sh               # Spec inválida
├── 80-periodic-reconcile-no-events.sh  # Reconciliação periódica sem eventos
├── 90-spec-update-rollout.sh        # Update de spec com rollout
├── 100-delete-partial-cleanup.sh    # Delete com cleanup parcial
├── 110-pvc-auto-resize.sh          # Resize automático de PVCs
├── 120-volumesnapshot-manual.sh     # VolumeSnapshot manual
├── 130-volumesnapshot-scheduled.sh  # VolumeSnapshot agendado
├── 140-api-collections.sh           # API: criar/listar collections
├── 150-api-restore.sh               # API: restore operations
├── 160-api-authentication.sh        # API: autenticação
├── 170-api-templates.sh             # API: templates CRD
└── 180-api-integration.sh           # API: E2E completo
```

## 🔧 Utilitários

### `utils.sh`

Funções compartilhadas para testes básicos:

- `log_info`, `log_warn`, `log_error`, `log_test` - Logging colorido
- `wait_for_resource` - Aguarda recurso ser criado
- `wait_for_deletion` - Aguarda recurso ser deletado
- `get_operator_pod` - Obtém nome do pod do operator
- `is_operator_leader` - Verifica se pod é leader

### `utils-api.sh`

Funções utilitárias para testes da API REST:

- `get_api_token` - Obtém token da API do operator
- `get_api_url` - Obtém URL base da API
- `api_request` - Faz requisição HTTP para a API
- `insert_dummy_data` - Insere dados dummy em uma collection
- `wait_for_collection_data` - Aguarda collection ter dados

## ✅ Critérios de Sucesso

Um operator confiável deve passar em todos estes testes:

1. ✅ **Happy Path**: Operação básica funciona
2. ✅ **Drift Detection**: Reconciliação declarativa funciona
3. ✅ **Idempotência**: Não causa rollouts desnecessários
4. ✅ **Finalizer Sob Carga**: Cleanup funciona durante atividade
5. ✅ **Finalizers**: Cleanup adequado
6. ✅ **HA**: Failover funciona
7. ✅ **HA Durante Reconcile**: Failover funciona durante operações ativas
8. ✅ **Spec Inválida**: Lida graciosamente com inputs inválidos
9. ✅ **Reconciliação Periódica**: Safety net funciona sem eventos
10. ✅ **Rollout Controlado**: Updates são seguros e controlados
11. ✅ **Cleanup Idempotente**: Lida com estado parcial
12. ✅ **API Collections**: API REST funciona para criar/listar collections
13. ✅ **API Restore**: API REST funciona para restore operations
14. ✅ **API Authentication**: Autenticação da API funciona corretamente
15. ✅ **API Templates**: Templates funcionam via API e CRD
16. ✅ **API Integration**: Fluxo completo API → CRD → Reconciler → Qdrant funciona

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
