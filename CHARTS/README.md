# secure-namespace-operator

Opérateur Kubernetes pour le provisionnement automatisé de namespaces sécurisés avec isolation réseau Cilium, ingress controller dédié et gateway d'egress par VIP.

> Ce chart empaquette un **moteur d'opérateur générique** (`templates/core/` — ne connaît aucun CRD en
> dur) et une **implémentation d'exemple**, `secure-namespace` (`templates/implementations/secure-namespace/`),
> qui fournit le CRD `SecureNamespace` documenté ci-dessous. Le CRD piloté est configurable via
> `values.yaml::crd` (`group`/`version`/`kind`/`plural`) — voir le README racine du repo pour brancher
> une autre implémentation sans toucher au moteur.

## TL;DR

```bash
helm install secure-namespace-operator oci://ghcr.io/ccoupel/charts/secure-namespace-operator \
  --namespace namespace-operator \
  --create-namespace \
  -f values.yaml
```

---

## Prérequis

| Composant | Requis | Usage |
|---|---|---|
| Kubernetes | ≥ 1.24 | — |
| Cilium CNI | ✅ | NetworkPolicies + L2 announcement (egress VIP) |
| cert-manager | ✅ | Certificat TLS pour le webhook |
| Kyverno | Optionnel | Validation/mutation des Ingress |

---

## Installation

### Depuis ghcr.io (OCI)

```bash
helm registry login ghcr.io \
  --username <github-user> --password <github-pat-write:packages>

helm install secure-namespace-operator \
  oci://ghcr.io/ccoupel/charts/secure-namespace-operator \
  --version 1.0.3 \
  --namespace namespace-operator \
  --create-namespace \
  -f values.yaml
```

### Depuis les sources

```bash
helm install secure-namespace-operator ./CHARTS \
  --namespace namespace-operator \
  --create-namespace \
  -f values.yaml
```

### Upgrade

```bash
helm upgrade secure-namespace-operator \
  oci://ghcr.io/ccoupel/charts/secure-namespace-operator \
  --namespace namespace-operator \
  -f values.yaml
```

### Désinstallation

```bash
helm uninstall secure-namespace-operator --namespace namespace-operator
```

> ⚠️ Le CRD `securenamespaces.secure-ns.example.com` est annoté `helm.sh/resource-policy: keep` — il **n'est pas supprimé** par `helm uninstall`. Pour une désinstallation complète, supprimer d'abord les `SecureNamespace` existants, puis le CRD manuellement :
> ```bash
> kubectl delete crd securenamespaces.secure-ns.example.com
> ```

---

## Configuration (`values.yaml`)

```yaml
# Namespace de déploiement de l'opérateur
namespace:
  name: namespace-operator
  create: true

# Domaine DNS de base du cluster
# Utilisé pour les certificats webhook et la validation des hostnames Ingress
dnsDomain: infra.example.com

# Configuration de l'opérateur
operator:
  debug_level: INFO          # DEBUG | INFO | WARNING | ERROR
  reconcile:
    intervalSeconds: 300     # Correction de dérive toutes les N secondes
    initialDelaySeconds: 60  # Délai au démarrage avant la 1ère réconciliation
  resources:
    requests:
      memory: "256Mi"
      cpu: "200m"
    limits:
      memory: "1Gi"
      cpu: "1000m"

# Proxy corporate (injecté dans l'opérateur et les VIP controllers)
proxy:
  enabled: false
  http: "http://proxy.example.com:8080"
  https: "http://proxy.example.com:8080"
  noProxy: "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,localhost,.example.com"

# Webhook de mutation/validation
webhook:
  replicas: 1
  resources:
    requests:
      memory: "128Mi"
      cpu: "100m"
    limits:
      memory: "256Mi"
      cpu: "500m"

# cert-manager — gestion automatique du certificat TLS du webhook
certManager:
  enabled: true
  issuer:
    create: true    # false si un Issuer existant est disponible

# ServiceAccount de l'opérateur
serviceAccount:
  create: true
  name: secure-namespace-operator
  annotations: {}
```

### Tableau des paramètres

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `namespace.name` | string | `namespace-operator` | Namespace de l'opérateur |
| `namespace.create` | bool | `true` | Créer le namespace si absent |
| `dnsDomain` | string | `infra.secure-ns.example.com` | Domaine DNS de base du cluster |
| `operator.debug_level` | string | `INFO` | Niveau de log Python |
| `operator.reconcile.intervalSeconds` | int | `300` | Intervalle de réconciliation périodique |
| `operator.reconcile.initialDelaySeconds` | int | `60` | Délai avant la première réconciliation |
| `operator.resources` | object | — | Ressources du pod opérateur |
| `proxy.enabled` | bool | `true` | Activer l'injection du proxy |
| `proxy.http` | string | — | URL proxy HTTP |
| `proxy.https` | string | — | URL proxy HTTPS |
| `proxy.noProxy` | string | — | Exceptions proxy (liste séparée par virgules) |
| `webhook.replicas` | int | `1` | Replicas du webhook |
| `webhook.resources` | object | — | Ressources du pod webhook |
| `certManager.enabled` | bool | `true` | Gérer le certificat via cert-manager |
| `certManager.issuer.create` | bool | `true` | Créer un Issuer self-signed |
| `serviceAccount.create` | bool | `true` | Créer le ServiceAccount |
| `serviceAccount.name` | string | `secure-namespace-operator` | Nom du ServiceAccount |
| `serviceAccount.annotations` | object | `{}` | Annotations sur le ServiceAccount |

---

## Utilisation — Créer un namespace sécurisé

L'opérateur gère des ressources `SecureNamespace` (CRD cluster-scoped, raccourci `sns`).

### Exemple minimal

```yaml
apiVersion: secure-ns.example.com/v1alpha1
kind: SecureNamespace
metadata:
  name: myapp-dev
spec:
  project:
    solution: myapp
    environment: DEV
```

```bash
kubectl apply -f myapp-dev.yaml
kubectl get sns
```

Le nom du namespace créé est calculé automatiquement : `{solution}-{environment}` → `myapp-dev`.

### Exemple avec ingress, egress et accès réseau

```yaml
apiVersion: secure-ns.example.com/v1alpha1
kind: SecureNamespace
metadata:
  name: myapp-dev
spec:
  project:
    solution: myapp
    environment: DEV
    contact:
      name: "Jean Dupont"
      email: "jean.dupont@example.com"

  ingress:
    enabled: true
    domain: "k8s.example.com"        # → accès: *.dev.myapp.k8s.example.com
    controller:
      type: traefik                   # nginx | haproxy | traefik
      replicas: 1

  egressController:
    enabled: true                     # VIP dédié pour le trafic sortant

  network:
    isolationEnabled: true
    externalAccess:
      enabled: true
      standard:
        logging: true
        proxy: true
      rules:
        - name: "API partenaire"
          fqdns: ["api.partner.com"]
          ports:
            - port: 443
              protocol: TCP

  quotas:
    enabled: true
    compute:
      requests.cpu: "2000m"
      requests.memory: "4Gi"
```

### Commandes utiles

```bash
# Lister tous les SecureNamespaces
kubectl get sns

# Vue détaillée (VIP, node, ingress, état)
kubectl get sns myapp-dev -o wide

# Consulter l'historique des changements (100 entrées max)
kubectl get configmap myapp-dev-history -n namespace-operator \
  -o jsonpath='{.data.history\.txt}'

# Logs de l'opérateur
kubectl logs -n namespace-operator deployment/secure-namespace-operator -f

# Logs du VIP controller d'un namespace spécifique
kubectl logs -n namespace-operator -l app=myapp-dev-vip-controller -f

# Supprimer un namespace sécurisé (le finalizer assure le nettoyage)
kubectl delete sns myapp-dev
```

---

## Étendre l'opérateur — Custom Template Order

Les templates déployés par ce chart **ne doivent pas être modifiés directement** : ils sont gérés par Helm et écrasés à chaque `helm upgrade`.

Pour ajouter des templates supplémentaires sans toucher au chart, le VIP controller supporte un ConfigMap de surcharge optionnel. Les templates qui y sont déclarés sont **appendés après les templates standards** à chaque réconciliation.

### Créer un custom template order

**1. Créer le ConfigMap d'ordre custom**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vip-controller-templates-order-custom
  namespace: namespace-operator        # même namespace que l'opérateur
data:
  templates-order.yaml: |
    templates:
      - my-custom-templates/extra-policy.yaml
    jobs:
      - my-custom-templates/extra-job.yaml
```

**2. Créer le ConfigMap contenant les templates**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-custom-templates
  namespace: namespace-operator
data:
  extra-policy.yaml: |
    apiVersion: cilium.io/v2
    kind: CiliumNetworkPolicy
    metadata:
      name: [{ namespace_name }]-extra
      namespace: [{ namespace_name }]
    [% if spec.network.externalAccess.standard.vault %]
    _action: apply
    spec:
      endpointSelector: {}
      egress:
        - toEntities:
            - world
          toPorts:
            - ports:
                - port: "8200"
                  protocol: TCP
    [% else %]
    _action: delete
    [% endif %]
```

```bash
kubectl apply -f vip-controller-templates-order-custom.yaml
kubectl apply -f my-custom-templates.yaml
```

> L'absence du ConfigMap `vip-controller-templates-order-custom` est silencieuse — l'opérateur continue avec les templates standards.

---

## Syntaxe Jinja2 dans les templates

Les templates utilisent des **délimiteurs personnalisés** pour éviter les conflits avec la syntaxe Helm `{{ }}` :

| Élément | Syntaxe |
|---|---|
| Variable | `[{ ma_variable }]` |
| Bloc conditionnel | `[% if condition %]` … `[% endif %]` |
| Boucle | `[% for item in liste %]` … `[% endfor %]` |
| Commentaire (ignoré au rendu) | `[# mon commentaire #]` |

### Exemples pratiques

```yaml
# Variable simple
name: [{ namespace_name }]

# Accès à un champ de spec
replicas: [{ spec.ingress.controller.replicas }]

# Condition sur un flag
[% if spec.ingress.enabled %]
_action: apply
spec:
  replicas: [{ spec.ingress.controller.replicas }]
[% else %]
_action: delete
[% endif %]

# Boucle sur une liste
[% for rule in spec.network.externalAccess.rules %]
- toFQDNs:
  [% for fqdn in rule.fqdns %]
  - matchName: [{ fqdn }]
  [% endfor %]
[% endfor %]

# Commentaire ignoré au rendu
[# Ce bloc ne sera pas présent dans le YAML final #]
```

### Champ `_action`

Chaque document YAML produit par un template peut contenir un champ `_action` pour piloter le cycle de vie de la ressource :

| Valeur | Comportement |
|---|---|
| `apply` (ou absent) | Crée la ressource si elle n'existe pas, la met à jour sinon |
| `delete` | Supprime la ressource si elle existe, no-op sinon |

---

## Dictionnaire de valeurs disponibles dans les templates

Il existe deux contextes de rendu avec des dictionnaires différents : les **templates de l'opérateur principal** (réconciliation du SecureNamespace) et les **templates du VIP controller** (gestion du VIP et de l'ingress).

---

### Opérateur principal — `templates-*`

Ces variables sont disponibles dans tous les templates listés dans `secure-namespace-operator-templates-order`.

#### Variables racines

| Variable | Type | Description |
|---|---|---|
| `solution` | string | `spec.project.solution` en minuscules |
| `environment` | string | `spec.project.environment` en minuscules |
| `namespace_name` | string | Nom du namespace généré : `{solution}-{environment}` |
| `securenamespace_name` | string | Nom de l'objet `SecureNamespace` |
| `operator_namespace` | string | Namespace où tourne l'opérateur |
| `revision` | int | Numéro de révision courant (incrémenté à chaque changement de `spec`) |
| `domain` | string | Domaine complet : `{environment}.{solution}.{ingress.domain}` |
| `labels` | dict | Labels standards (voir détail ci-dessous) |
| `annotations` | dict | Annotations standards (voir détail ci-dessous) |
| `spec` | dict | Spec complète avec les valeurs par défaut du CRD appliquées |

#### Contenu de `labels`

```yaml
app.kubernetes.io/name: <solution>
app.kubernetes.io/instance: <namespace_name>
app.kubernetes.io/version: "<revision>"
app.kubernetes.io/component: namespace
app.kubernetes.io/part-of: <solution>
app.kubernetes.io/managed-by: secure-namespace-operator
secure-ns.example.com/solution: <solution>
secure-ns.example.com/environment: <environment>
secure-ns.example.com/managed: "true"
secure-ns.example.com/securenamespace: <securenamespace_name>
environment: <environment>
solution: <solution>
```

#### Contenu de `annotations`

```yaml
secure-ns.example.com/created-by: secure-namespace-operator
secure-ns.example.com/created-at: <timestamp ISO>
secure-ns.example.com/securenamespace: <securenamespace_name>
secure-ns.example.com/crd-namespace: <operator_namespace>
secure-ns.example.com/revision: "<revision>"
```

---

### VIP Controller — `vip-controller-templates` et `vip-controller-templates-jobs`

Le VIP controller dispose de son propre dictionnaire, **plus riche**, passé à ses templates lors de chaque réconciliation.

#### Variables de base (toujours présentes)

| Variable | Type | Description |
|---|---|---|
| `solution` | string | `spec.project.solution` en minuscules |
| `environment` | string | `spec.project.environment` en minuscules |
| `namespace_name` | string | Nom du namespace : `{solution}-{environment}` |
| `securenamespace_name` | string | Nom de l'objet `SecureNamespace` |
| `operator_namespace` | string | Namespace où tourne l'opérateur |
| `domain` | string | Domaine complet : `{environment}.{solution}.{ingress.domain}` |
| `l2_policy_name` | string | Nom de la `CiliumL2AnnouncementPolicy` : `{namespace_name}-l2-policy` |
| `egress_policy_name` | string | Nom de la `CiliumEgressGatewayPolicy` : `{namespace_name}-egress` |
| `spec` | dict | Spec complète avec les valeurs par défaut du CRD appliquées |

> ⚠️ `revision`, `labels` et `annotations` ne sont **pas** présents dans le contexte du VIP controller.

#### Variables de réconciliation (ajoutées à chaque cycle)

| Variable | Type | Description |
|---|---|---|
| `node_name` | string | Nœud sélectionné pour héberger le VIP lors de ce cycle |
| `egress_ip` | string | Adresse IP VIP active (issue du LoadBalancer service) |
| `previous_vip` | string | VIP du cycle de réconciliation précédent |
| `previous_node` | string | Nœud du cycle de réconciliation précédent |
| `last_vip` | string | Dernière VIP connue annotée sur le `SecureNamespace` (jamais vide après le 1er cycle) |
| `last_node` | string | Dernier nœud connu annoté sur le `SecureNamespace` (jamais vide après le 1er cycle) |
| `is_first_run` | bool | `true` si c'est la première réconciliation (aucune annotation VIP existante) |
| `vip_changed` | bool | `true` si l'IP VIP a changé depuis le cycle précédent |
| `node_changed` | bool | `true` si le nœud a changé depuis le cycle précédent |
| `initialized` | bool | `true` si le VIP controller a déjà complété au moins un cycle complet |
| `previous_spec` | dict | Spec du `SecureNamespace` lors du cycle précédent (pour détecter les transitions de configuration) |
| `eligible_nodes` | list[string] | Liste triée des nœuds éligibles (prêts + correspondant au `nodeSelector`) |
| `timestamp` | string | Horodatage UTC du cycle courant au format `YYYY-MM-DDTHH-MM-SSZ` |

---

### `spec` — sous-clés accessibles (commun aux deux contextes)

```
spec.project.solution
spec.project.environment
spec.project.contact.name
spec.project.contact.email

spec.quotas.enabled
spec.quotas.compute['requests.cpu']
spec.quotas.compute['requests.memory']
spec.quotas.compute['limits.cpu']
spec.quotas.compute['limits.memory']
spec.quotas.storage['requests.storage']
spec.quotas.storage.persistentvolumeclaims
spec.quotas.objects.pods
spec.quotas.objects.services
spec.quotas.objects.configmaps
spec.quotas.objects.secrets

spec.network.interfaceName
spec.network.isolationEnabled
spec.network.externalAccess.enabled
spec.network.externalAccess.rules          # liste: {name, cidrs, fqdns, ports}
spec.network.externalAccess.services       # liste: {name, namespace, ports}
spec.network.externalAccess.namespaces     # liste: {name, ports}
spec.network.externalAccess.standard.logging
spec.network.externalAccess.standard.proxy
spec.network.externalAccess.standard.vault
spec.network.externalAccess.standard.git
spec.network.externalAccess.standard.s3
spec.network.externalAccess.standard.smtp

spec.ingress.enabled
spec.ingress.serviceName
spec.ingress.domain
spec.ingress.controller.type               # nginx | haproxy | traefik
spec.ingress.controller.replicas
spec.ingress.controller.nodeSelector.label
spec.ingress.controller.nodeSelector.value
spec.ingress.controller.resources.requests.cpu
spec.ingress.controller.resources.requests.memory
spec.ingress.controller.resources.limits.cpu
spec.ingress.controller.resources.limits.memory

spec.egressController.enabled
spec.egressController.reconcileIntervalSeconds

spec.example.enabled
spec.example.image
spec.example.hostPrefix

spec.serviceaccount.enabled
spec.serviceaccount.name
spec.serviceaccount.roles                  # liste de règles RBAC namespacées
spec.serviceaccount.clusterroles           # liste de règles RBAC cluster-scoped
```

---

## Dépannage rapide

| Symptôme | Vérification |
|---|---|
| Pod opérateur en `CrashLoopBackOff` | `kubectl logs -n namespace-operator deploy/secure-namespace-operator` |
| SecureNamespace bloqué en création | `kubectl describe sns <n>` + logs opérateur |
| Ingress non créé | Vérifier `spec.ingress.enabled: true` + logs VIP controller |
| VIP non assigné | Vérifier que des nœuds ont le label `spec.ingress.controller.nodeSelector` |
| Template custom non appliqué | Vérifier l'existence du ConfigMap `vip-controller-templates-order-custom` dans le bon namespace, et que les ConfigMaps référencés existent |
| Webhook rejection | `kubectl logs -n namespace-operator deploy/secure-namespace-webhook` |
| Erreur `environment` invalide | Valeurs acceptées : `TEST`, `DEV`, `INTEG`, `PROD` (insensible à la casse) |