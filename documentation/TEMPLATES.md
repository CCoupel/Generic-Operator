# Structure des Templates - Secure Namespace Operator

Ce document explique l'architecture multi-ConfigMap des templates Jinja2 de l'implémentation
`secure-namespace`, rendus par le moteur générique (`CHARTS/templates/core/CODE/3_operator.yml`).

> Ce sont des templates **runtime** (rendus par l'opérateur Python à chaque réconciliation), à ne pas
> confondre avec les templates **Helm** (rendus une fois à `helm install`/`helm upgrade`). Voir
> "Délimiteurs Jinja2" ci-dessous — c'est la source #1 d'erreurs si on l'oublie.

## 📋 Vue d'ensemble

Les templates sont organisés en **plusieurs ConfigMaps thématiques** pour une meilleure maintenabilité et modularité.

### Avantages de cette approche

✅ **Modularité** : Chaque ConfigMap a une responsabilité claire
✅ **Limite de taille** : Évite de dépasser la limite de 1MB par ConfigMap
✅ **Maintenabilité** : Facile de trouver et modifier un template spécifique
✅ **Découverte automatique** : Ajouter un ConfigMap ne nécessite **aucune** modification du code Python
   (voir [Fonctionnement](#-fonctionnement) — le nom du ConfigMap est extrait directement de
   `templates-order.yaml`, jamais d'une liste en dur)

---

## 🗂️ Organisation des ConfigMaps

### ConfigMap Principal : `secure-namespace-operator-templates-order`

**Rôle** : Définit l'ordre d'exécution des templates. Ce nom de ConfigMap est **actuellement en dur**
dans `template_manager.py::load_templates_order()` (côté moteur générique) — une nouvelle implémentation
doit soit nommer son propre ConfigMap d'ordre exactement ainsi, soit paramétrer cette ligne (voir la
section "Building Your Own Implementation" du README racine).

**Fichier source** : `CHARTS/templates/implementations/secure-namespace/TEMPLATES/1.0_templates_order.yml`

**Format du fichier `templates-order.yaml`** :
```yaml
templates:
  - configmap-name/template-key.yaml
  - configmap-name/another-template.yaml
```

**Exemple** :
```yaml
templates:
  - templates-core/namespace.yaml
  - templates-core/resource-quota.yaml
  - templates-network/network-policy.yaml
```

---

### ConfigMaps de Templates

| ConfigMap | Description | Fichier source (`implementations/secure-namespace/`) |
|-----------|-------------|-----------|
| **templates-core** | Ressources de base (Namespace, Quotas) | `TEMPLATES/1.1_templates_core.yml` |
| **templates-network** | Politiques réseau Cilium | `TEMPLATES/1.2_templates_network.yml` |
| **templates-ingress** (common) | Ressources ingress communes | `CONTROLER/TEMPLATES/1.3_templates_ingress_common.yml` |
| **templates-ingress-nginx** | Ingress Controller NGINX | `CONTROLER/TEMPLATES/1.4_templates_ingress_nginx.yml` |
| **templates-ingress-haproxy** | Ingress Controller HAProxy | `CONTROLER/TEMPLATES/1.5_templates_ingress_haproxy.yml` |
| **templates-ingress-traefik** | Ingress Controller Traefik | `CONTROLER/TEMPLATES/1.6_templates_ingress_traefik.yml` |
| **templates-egress** | Egress VIP Controller (Deployment + RBAC) | `TEMPLATES/1.7_templates_vip_controller.yml` |
| **templates-apps** | Application d'exemple | `TEMPLATES/1.8_templates_example.yml` |
| **templates-rbac** | Service Accounts et RBAC par namespace créé | `TEMPLATES/1.9_templates_rbac.yml` |

---

## 🔧 Fonctionnement

### 1. Chargement de l'ordre

`template_manager.py::load_templates_order()` lit le ConfigMap `secure-namespace-operator-templates-order`
et retourne la liste `['templates-core/namespace.yaml', ...]`.

### 2. Chargement des templates — découverte automatique des ConfigMaps

`template_manager.py::load_templates(templates_list)` **dérive le nom de chaque ConfigMap directement
de la liste reçue** (`cm_name, file_key = template_key.split('/', 1)`) — il n'existe **aucune** liste de
noms de ConfigMaps en dur à maintenir côté Python :

```python
def load_templates(templates_list):
    """
    Charge les templates depuis PLUSIEURS ConfigMaps
    en se basant sur la liste fournie au format 'configmap/key'
    """
    templates = {}
    configmaps_cache = {}  # cache pour ne charger chaque ConfigMap qu'une fois

    for template_key in templates_list:
        cm_name, file_key = template_key.split('/', 1)

        if cm_name not in configmaps_cache:
            config_map = v1.read_namespaced_config_map(name=cm_name, namespace=OPERATOR_NAMESPACE)
            configmaps_cache[cm_name] = config_map.data or {}

        cm_data = configmaps_cache[cm_name]
        if file_key in cm_data:
            templates[template_key] = cm_data[file_key]

    return templates
```

**Conséquence pratique** : ajouter un nouveau ConfigMap de templates ne nécessite de toucher **que**
`templates-order.yaml` (référencer `nouveau-configmap/cle.yaml`) — jamais `template_manager.py`.

### 3. Application des templates

```python
templates = load_templates(templates_to_apply)     # Dict {'configmap/key': contenu}
templates_to_apply = load_templates_order()          # Liste ordonnée

for template_key in templates_to_apply:
    template_content = templates[template_key]
    rendered = render_template(template_content, values)   # Jinja2, délimiteurs custom — voir plus bas
    # Apply resources...
```

---

## ⚠️ Délimiteurs Jinja2 — à lire avant d'écrire un template

`template_manager.py::render_template()` configure un `Environment` Jinja2 avec des délimiteurs **non
standards**, précisément pour que le texte du template survive au rendu Helm (ces ConfigMaps sont
eux-mêmes des templates Helm) :

```python
env = Environment(
    loader=BaseLoader(),
    variable_start_string='[{', variable_end_string='}]',
    block_start_string='[%', block_end_string='%]',
    comment_start_string='[#', comment_end_string='#]',
)
```

| Usage | Syntaxe réelle | Jamais |
|---|---|---|
| Variable | `[{ namespace_name }]` | ~~`{{ namespace_name }}`~~ |
| Bloc | `[% if spec.monitoring.enabled %]` ... `[% endif %]` | ~~`{% if %}` ... `{% endif %}`~~ |
| Commentaire | `[# note #]` | ~~`{# note #}`~~ |

Utiliser `{{ }}`/`{% %}` dans un fichier sous `TEMPLATES/` se fait consommer par **Helm** au moment du
`helm install`/`helm template` — l'opérateur ne voit jamais la variable, et selon le contexte ça produit
soit une erreur Helm (valeur inconnue), soit pire, un rendu silencieusement faux.

---

## ➕ Ajouter un nouveau template

### Étape 1 : Créer/Modifier un ConfigMap

Dans un fichier sous `CHARTS/templates/implementations/secure-namespace/TEMPLATES/` (nouveau fichier ou
ajout à un fichier existant) :

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: templates-monitoring  # Nouveau ConfigMap
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "secure-namespace-operator.labels" . | nindent 4 }}
    app.kubernetes.io/component: deployment-template
data:
  prometheus.yaml: |
    apiVersion: v1
    kind: ServiceMonitor
    metadata:
      name: [{ namespace_name }]-monitor
      namespace: [{ namespace_name }]
    [% if spec.monitoring.enabled %]
    _action: apply
    spec:
      selector:
        matchLabels:
          app: [{ namespace_name }]-app
      endpoints:
      - port: metrics
        interval: 30s
    [% else %]
    _action: delete
    [% endif %]
```

### Étape 2 : Ajouter à l'ordre d'exécution

Dans `implementations/secure-namespace/TEMPLATES/1.0_templates_order.yml` :

```yaml
templates-order.yaml: |
  templates:
    - templates-core/namespace.yaml
    - templates-core/resource-quota.yaml
    # ...
    - templates-monitoring/prometheus.yaml  # ← NOUVEAU
```

C'est **tout** côté code — `template_manager.py` n'a rien à connaître de `templates-monitoring` à
l'avance (voir [Fonctionnement](#-fonctionnement)).

### Étape 3 : Mettre à jour le CRD (si nouveau champ spec nécessaire)

Dans `implementations/secure-namespace/CRD/0_CRD.yml`, avec un `default` explicite :

```yaml
spec:
  monitoring:
    type: object
    properties:
      enabled:
        type: boolean
        default: false
```

### Étape 4 : Appliquer les changements

```bash
helm upgrade secure-namespace-operator ./CHARTS -n namespace-operator -f values.yaml
kubectl rollout restart deployment/secure-namespace-operator -n namespace-operator
```

---

## 🔄 Modifier un template existant

Le ConfigMap est généré par Helm depuis les fichiers sous `implementations/secure-namespace/TEMPLATES/`
— un `kubectl edit configmap` direct sera **écrasé** au prochain `helm upgrade`. Toujours éditer la
source :

```bash
# 1. Modifier le fichier source, ex :
vim CHARTS/templates/implementations/secure-namespace/TEMPLATES/1.1_templates_core.yml

# 2. Vérifier le rendu
helm template ./CHARTS | less

# 3. Appliquer
helm upgrade secure-namespace-operator ./CHARTS -n namespace-operator -f values.yaml

# 4. Redémarrer pour recharger (le Deployment ne watch pas les ConfigMaps)
kubectl rollout restart deployment/secure-namespace-operator -n namespace-operator
```

---

## 🗑️ Supprimer un template

### Étape 1 : Retirer de l'ordre d'exécution

Dans `1.0_templates_order.yml` :

```yaml
templates:
  # - templates-apps/example-app.yaml  # ← Commenté/supprimé
```

### Étape 2 : Optionnel — supprimer la clé du ConfigMap source

Retirer le bloc `example-app.yaml: |` du fichier `implementations/secure-namespace/TEMPLATES/1.8_templates_example.yml`
correspondant, puis `helm upgrade`.

---

## 📊 Visualiser la structure

### Lister tous les ConfigMaps de templates

```bash
kubectl get configmaps -n namespace-operator \
  -l app.kubernetes.io/component=deployment-template
```

### Voir le contenu d'un ConfigMap

```bash
# Voir les clés disponibles
kubectl get configmap templates-core -n namespace-operator \
  -o jsonpath='{.data}' | jq 'keys'

# Voir un template spécifique
kubectl get configmap templates-core -n namespace-operator \
  -o jsonpath='{.data.namespace\.yaml}'
```

### Voir l'ordre d'exécution

```bash
kubectl get configmap secure-namespace-operator-templates-order \
  -n namespace-operator \
  -o jsonpath='{.data.templates-order\.yaml}'
```

---

## 🧪 Tester un template

### Test de rendu Jinja2 local

Reproduire l'`Environment` exact du moteur — les délimiteurs Jinja2 par défaut testeraient la mauvaise
syntaxe :

```python
from jinja2 import Environment, BaseLoader

env = Environment(
    loader=BaseLoader(),
    variable_start_string='[{', variable_end_string='}]',
    block_start_string='[%', block_end_string='%]',
    comment_start_string='[#', comment_end_string='#]',
)

template_content = """
apiVersion: v1
kind: Namespace
metadata:
  name: [{ namespace_name }]
  labels:
    solution: [{ solution }]
"""

values = {
    'namespace_name': 'myapp-dev',
    'solution': 'myapp'
}

template = env.from_string(template_content)
print(template.render(**values))
```

### Test avec dry-run

```bash
# Créer un SecureNamespace en dry-run
kubectl apply --dry-run=server -f CHARTS/examples/example.yml

# Vérifier les logs de l'opérateur
kubectl logs -n namespace-operator deployment/secure-namespace-operator -f
```

---

## 🔍 Debugging

### Template non trouvé

**Erreur** :
```
⚠️  Fichier 'namespace.yaml' non trouvé dans ConfigMap 'templates-core'
```

**Solutions** :
1. Vérifier que le ConfigMap existe :
```bash
kubectl get configmap templates-core -n namespace-operator
```

2. Vérifier que la clé existe dans le ConfigMap :
```bash
kubectl get configmap templates-core -n namespace-operator \
  -o jsonpath='{.data}' | jq 'keys'
```

3. Vérifier l'entrée exacte dans `templates-order.yaml` (le nom du ConfigMap et la clé doivent
   correspondre exactement, séparés par un seul `/`) :
```bash
kubectl get configmap secure-namespace-operator-templates-order -n namespace-operator \
  -o jsonpath='{.data.templates-order\.yaml}'
```

### Erreur de rendu Jinja2

**Erreur** :
```
jinja2.exceptions.UndefinedError: 'spec' is undefined
```

**Solution** : Vérifier que toutes les variables utilisées dans le template sont fournies par
`template_manager.py::get_template_values()` (`spec`, `solution`, `environment`, `namespace_name`,
`securenamespace_name`, `operator_namespace`, `revision`, `labels`, `annotations`, `domain`) — et que le
template utilise bien `[{ }]`, pas `{{ }}`.

### Ordre d'exécution incorrect

**Problème** : Les ressources sont créées dans le mauvais ordre (ex: Deployment avant Namespace)

**Solution** : Vérifier `1.0_templates_order.yml` et s'assurer que `templates-core/namespace.yaml` est en premier.

---

## 📚 Bonnes pratiques

### 1. Nommage des ConfigMaps

- Préfixe : `templates-`
- Nom descriptif : `templates-network`, `templates-ingress-nginx`
- Singulier/Pluriel cohérent

### 2. Organisation des templates

- **Un template par fichier** quand possible
- **Regrouper** les ressources liées (RBAC d'un controller ensemble)
- **Séparer** les concerns (network ≠ ingress ≠ rbac)

### 3. Labels sur les ConfigMaps

```yaml
labels:
  {{- include "secure-namespace-operator.labels" . | nindent 4 }}
  app.kubernetes.io/component: deployment-template
```

### 4. Documentation dans les templates

Les commentaires à l'intérieur d'un bloc `data: <key>: |` sont du texte Jinja2/YAML littéral (pas du
YAML de premier niveau) — utiliser `#` (YAML) ou `[# ... #]` (commentaire Jinja2, invisible même après
rendu) selon ce qui doit survivre au rendu :

```yaml
data:
  network-policy.yaml: |
    # Ce template crée la NetworkPolicy d'isolation de base
    # Condition : spec.network.isolationEnabled == true
    apiVersion: cilium.io/v2
    kind: CiliumNetworkPolicy
    # ...
```

### 5. Gestion des versions

- Utiliser Git pour versionner les templates (ils vivent dans ce repo, pas édités live en cluster)
- Tag les releases importantes (`vX.Y.Z`, déclenche la CI de packaging/publication)
- Documenter les breaking changes

---

## 📖 Résumé

| Aspect | Valeur actuelle |
|--------|------------------|
| **ConfigMaps** | 9 thématiques (voir tableau plus haut) |
| **Taille max** | ~1MB par ConfigMap |
| **Format clés `templates-order.yaml`** | `configmap-name/template-key.yaml` |
| **Découverte des ConfigMaps** | Automatique, dérivée de `templates-order.yaml` — rien à déclarer côté Python |
| **Délimiteurs Jinja2** | `[{ }]` / `[% %]` / `[# #]` — jamais `{{ }}` / `{% %}` / `{# #}` |
| **Déploiement** | Helm (`helm upgrade`), jamais `kubectl apply -f <fichier brut>` |
