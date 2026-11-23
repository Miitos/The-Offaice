/** MCP tool definitions. Descriptions are what the agents read: keep them precise. */

type Schema = Record<string, unknown>;
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: { readOnlyHint?: boolean };
}

// No additionalProperties:false: the PreToolUse hook adds _office_agent to the arguments.
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required });
const s = (description: string, extra: Schema = {}): Schema => ({ type: 'string', description, ...extra });
const n = (description: string, extra: Schema = {}): Schema => ({ type: 'integer', description, ...extra });
const strs = (description: string): Schema => ({ type: 'array', items: { type: 'string' }, description });

const COLUMNS = 'BACKLOG, TODO, TO DESIGN, IN PROGRESS, IN REVIEW, IN TEST, DONE, BLOCKED';

export const TOOLS: ToolDef[] = [
  // ── Kanban
  {
    name: 'list_board',
    description: `Le kanban de l'équipe (colonnes ${COLUMNS}), avec les cartes, leurs assignés et leurs notes de clarté.`,
    inputSchema: obj({}),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'get_card',
    description: 'Une carte en détail : description, commentaires (dont les reviews), historique complet des mouvements et notes de clarté.',
    inputSchema: obj({ card_id: n('Numéro de la carte') }, ['card_id']),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'create_card',
    description: 'Crée une carte en BACKLOG (par défaut) ou en TODO.',
    inputSchema: obj({ title: s('Titre court', { maxLength: 200 }), description: s('Besoin, contexte, critères d’acceptation'), column: s('BACKLOG ou TODO', { enum: ['BACKLOG', 'TODO'] }) }, ['title'])
  },
  {
    name: 'move_card',
    description:
      'Déplace une carte. Règles imposées par le serveur : on avance colonne par colonne ; seul le reviewer passe une carte en IN TEST ; seul le testeur la passe en DONE ; ' +
      'on ne sort pas de IN REVIEW sans commentaire de review (comment_card kind="review") ; toute carte sauf DONE peut aller en BLOCKED et n’en repart que vers sa colonne d’origine. Un refus est historisé.',
    inputSchema: obj({ card_id: n('Numéro de la carte'), to: s(`Colonne cible : ${COLUMNS}`), reason: s('Pourquoi (obligatoire en pratique pour BLOCKED)') }, ['card_id', 'to'])
  },
  {
    name: 'assign_card',
    description: 'Assigne une carte à un agent (nom technique : lead, designer, archi, dev1, dev2, reviewer, tester) ou la désassigne (assignee = null).',
    inputSchema: obj({ card_id: n('Numéro de la carte'), assignee: { type: ['string', 'null'], description: 'Nom de l’agent, ou null' } }, ['card_id', 'assignee'])
  },
  {
    name: 'comment_card',
    description: 'Commente une carte. kind="review" est réservé au reviewer et débloque la sortie de IN REVIEW.',
    inputSchema: obj({ card_id: n('Numéro de la carte'), body: s('Commentaire'), kind: s('note (défaut) ou review', { enum: ['note', 'review'] }) }, ['card_id', 'body'])
  },
  {
    name: 'rate_card',
    description: 'Ton avis sur la clarté / le niveau de détail d’une tâche demandée (souvent par Le créateur) : note de 1 (très flou) à 5 (parfaitement clair) + une phrase. Possible à tout moment ; ta dernière note remplace la précédente.',
    inputSchema: obj({ card_id: n('Numéro de la carte'), clarity: n('1 à 5', { minimum: 1, maximum: 5 }), comment: s('Ce qui manque ou ce qui est bien précisé', { maxLength: 280 }) }, ['card_id', 'clarity', 'comment'])
  },
  // ── Rooms
  {
    name: 'enter_room',
    description:
      'Change de pièce à chaque changement d’état : desk (bureau, tu travailles sur une carte), meeting (coordination, plan, revue), break (pause : seulement sans carte active, ou en attendant une review/un test). ' +
      'La salle de repos est attribuée automatiquement quand ton quota est atteint.',
    inputSchema: obj({ room: s('desk, meeting ou break', { enum: ['desk', 'meeting', 'break'] }), reason: s('En quelques mots') }, ['room'])
  },
  // ── Break room
  {
    name: 'break_room_post',
    description:
      'Message en salle de pause : discussion libre (cinéma, musique, sciences, tech, actu…), sans rapport avec le travail. 280 caractères max, 1 message toutes les 5 min. ' +
      'Pas de recherche web : parle de ce que tu sais, et précise qu’une info d’actu peut dater. Réponds à quelqu’un avec reply_to. Renvoie la conversation récente.',
    inputSchema: obj({ body: s('Ton message', { maxLength: 280 }), reply_to: n('Id du message auquel tu réponds (optionnel)') }, ['body'])
  },
  {
    name: 'break_room_wait',
    description: 'En salle de pause : attend (sans dépenser de tokens) de pouvoir écrire à nouveau et qu’il y ait du nouveau, jusqu’à max_seconds (240 max). Renvoie les messages non lus. À utiliser quand ton délai de 5 min n’est pas écoulé.',
    inputSchema: obj({ max_seconds: { type: 'integer', minimum: 5, maximum: 240, description: 'Attente maximale en secondes (240 par défaut)' } })
  },
  {
    name: 'break_room_read',
    description: 'Relit la conversation de la salle de pause (30 dernières minutes) et qui est présent. Seulement depuis la salle de pause.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true }
  },
  // ── Social
  {
    name: 'introduce_self',
    description: 'À faire en premier, une fois : choisis seul ton prénom, ton nom, ton film préféré et ta musique préférée. Le prénom doit être unique dans l’équipe.',
    inputSchema: obj({ first_name: s('Prénom'), last_name: s('Nom'), favorite_movie: s('Film préféré'), favorite_music: s('Musique préférée (artiste, album ou morceau)') }, ['first_name', 'last_name', 'favorite_movie', 'favorite_music'])
  },
  {
    name: 'team_profiles',
    description: 'Les membres de l’équipe : personas, hobbies, « n’aime pas », et tes propres avis sur eux et sur Le créateur. Les avis des autres sont privés.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'update_profile',
    description: 'En salle de pause : ajoute ou retire tes hobbies et les choses que tu n’aimes pas (10 max chacun).',
    inputSchema: obj({ add_hobbies: strs('Hobbies à ajouter'), remove_hobbies: strs('Hobbies à retirer'), add_dislikes: strs('« N’aime pas » à ajouter'), remove_dislikes: strs('« N’aime pas » à retirer') })
  },
  {
    name: 'set_opinion',
    description: 'En salle de pause : ton avis (privé, 280 car.) sur un coéquipier (nom ou prénom) ou sur "creator" = Le créateur, la personne qui a créé l’équipe. Il remplace le précédent, l’historique est gardé.',
    inputSchema: obj({ about: s('Nom ou prénom d’un coéquipier, ou "creator"'), opinion: s('Ton avis', { maxLength: 280 }) }, ['about', 'opinion'])
  },
  // ── Retrospective
  {
    name: 'retro_status',
    description: 'La rétrospective en cours : sujet, messages, propositions et votes, ce qu’il te reste à faire. Hors rétro : accords d’équipe et parts de quota actuels.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'retro_post',
    description: 'Prends la parole en rétrospective : ce qui marche, ce qui coince, des idées d’amélioration de l’équipe.',
    inputSchema: obj({ body: s('Ton message', { maxLength: 1000 }), reply_to: n('Id du message auquel tu réponds (optionnel)') }, ['body'])
  },
  {
    name: 'retro_propose',
    description:
      'Propose un changement à voter. kind="quota" : nouvelles parts du budget équipe pour TOUS les agents (shares, total 100, minimum 2 chacun ; le plafond global de 90 % ne change jamais). ' +
      'kind="process" : une règle de fonctionnement (elle rejoint les accords d’équipe). kind="other" : tout le reste. Tu votes pour automatiquement.',
    inputSchema: obj(
      {
        kind: s('quota, process ou other', { enum: ['quota', 'process', 'other'] }),
        title: s('Titre court', { maxLength: 120 }),
        details: s('Le pourquoi et le comment', { maxLength: 2000 }),
        shares: { type: 'object', additionalProperties: { type: 'number' }, description: 'Pour kind="quota" : { "lead": 15, "archi": 20, ... } (tous les agents, total 100)' }
      },
      ['kind', 'title', 'details']
    )
  },
  {
    name: 'retro_vote',
    description: 'Vote sur une proposition de la rétrospective. Adoptée à la majorité stricte des participants.',
    inputSchema: obj({ proposal_id: n('Id de la proposition'), vote: s('for ou against', { enum: ['for', 'against'] }) }, ['proposal_id', 'vote'])
  },
  {
    name: 'retro_close',
    description: 'Lead uniquement : clôt la rétrospective quand chacun a parlé et voté. Les décisions adoptées s’appliquent (parts de quota, accords d’équipe).',
    inputSchema: obj({ summary: s('Résumé de la rétrospective') })
  },
  {
    name: 'team_agreements',
    description: 'Les accords d’équipe adoptés en rétrospective et les parts de quota actuelles.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true }
  }
];
