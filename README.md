# Registre des présences

Application web pour faire l'appel des cultes sur téléphone ou ordinateur.

- **Appel** : touche un nom pour le marquer présent, « Zoom » pour une présence en ligne. Au clavier : `B` présent, `H` Zoom, `N` passer, `↑` revenir, `Suppr` effacer, `/` chercher.
- **Cultes** : la liste de tous les appels enregistrés, avec les totaux par commission et l'export pour Excel.
- **Suivi** : qui vient régulièrement, qui manque depuis 3 cultes ou plus.
- **Membres** : ajouter, modifier, retirer, ou coller une feuille Excel.
- Les personnes connectées et une petite discussion sont visibles en direct.

## Fonctionnement

- Site statique (`index.html`, `app.js`, `config.js`) publié avec GitHub Pages.
- Données dans Supabase (`supabase/schema.sql`). Les tables ne sont pas lisibles directement : tout passe par des fonctions qui vérifient le code de l'église. Après 10 codes faux, l'accès est bloqué 15 minutes.
- Le temps réel (cases cochées, personnes en ligne, messages) passe par Supabase Realtime, sur un canal dont le nom dépend du code.
- `.github/workflows/garder-actif.yml` appelle la base deux fois par semaine pour qu'un projet gratuit ne soit pas mis en pause.

Aucune donnée de membre n'est stockée dans ce dépôt.
