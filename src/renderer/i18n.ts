import { useStore } from './store'

export type Language = 'en' | 'ru'

/**
 * A flat dictionary keyed by the English string.
 *
 * Using the source text as the key means an untranslated string still renders
 * correctly in English rather than as a missing-key placeholder — the failure
 * mode of a half-finished translation is "some English", not "some garbage".
 */
const RU: Record<string, string> = {
  /* Title bar and shell */
  Chat: 'Чат',
  Edit: 'Редактор',
  Settings: 'Настройки',
  Terminal: 'Терминал',
  Agent: 'Агент',
  Explorer: 'Файлы',
  Files: 'Файлы',
  Git: 'Git',
  History: 'История',
  Review: 'Проверка',
  'Source control': 'Контроль версий',
  'Saved conversations': 'Сохранённые диалоги',
  'Open a different folder': 'Открыть другую папку',
  'New conversation': 'Новый диалог',
  '+ new': '+ новый',
  'Toggle terminal (Ctrl+`)': 'Терминал (Ctrl+`)',
  'Settings (Ctrl+,)': 'Настройки (Ctrl+,)',

  /* Composer */
  'Ask, or describe a change — / commands, @ files, paste images':
    'Спросите или опишите правку — / команды, @ файлы, вставка картинок',
  'Add to what it is doing — sent at the next step. Esc to interrupt.':
    'Дополните текущую задачу — уйдёт на следующем шаге. Esc — прервать.',
  'Drop files here': 'Перетащите файлы сюда',
  '■ stop': '■ стоп',
  'read-only': 'только чтение',
  'can edit': 'может править',
  'bypassing permissions': 'без подтверждений',
  'commands: auto': 'команды: авто',
  'commands: ask': 'команды: спрашивать',
  'review changes': 'с проверкой',
  'ask each edit': 'спрашивать каждую',
  'apply silently': 'молча',
  'to review': 'на проверку',
  'no model': 'модель не выбрана',

  /* Review screen */
  'Nothing to review': 'Нечего проверять',
  'Changes the agent makes in review mode collect here.':
    'Правки агента в режиме проверки собираются здесь.',
  'Back to the editor': 'Вернуться к редактору',
  'Keep all': 'Принять все',
  'Revert all': 'Откатить все',
  Keep: 'Принять',
  Revert: 'Откатить',
  open: 'открыть',
  new: 'новый',
  edit: 'правка',

  /* Git */
  'Commit message': 'Сообщение коммита',
  Refresh: 'Обновить',
  'Working tree clean.': 'Рабочее дерево чистое.',
  'This folder is not a git repository.': 'Эта папка не является git-репозиторием.',
  stage: 'в индекс',
  unstage: 'из индекса',
  'stage all': 'все в индекс',
  'unstage all': 'все из индекса',

  /* Permission dialog */
  'Allow once': 'Разрешить один раз',
  Reject: 'Отклонить',
  'Reject with feedback (optional)': 'Отклонить с пояснением (необязательно)',
  'Ctrl+Enter allow · Esc reject': 'Ctrl+Enter разрешить · Esc отклонить',
  'The agent wants to run this command in your workspace.':
    'Агент хочет выполнить эту команду в вашем проекте.',
  'The agent wants to apply this change.': 'Агент хочет применить это изменение.',
  'This file is outside the folder you opened. Nothing is read or written until you allow it.':
    'Этот файл вне открытой папки. Ничего не читается и не пишется без вашего разрешения.',
  'An MCP server tool wants to run. It can act outside this app.':
    'Инструмент MCP-сервера хочет выполниться. Он может действовать за пределами приложения.',

  /* Settings */
  Close: 'Закрыть',
  'Save changes': 'Сохранить',
  Saved: 'Сохранено',
  Revert_settings: 'Отменить',
  'Ctrl+S save · Esc close': 'Ctrl+S сохранить · Esc закрыть',
  'Providers & models': 'Провайдеры и модели',
  Skills: 'Навыки',
  'MCP servers': 'MCP-серверы',
  Permissions: 'Права',
  'Agent behaviour': 'Поведение агента',
  Appearance: 'Внешний вид',
  About: 'О программе',
  Theme: 'Тема',
  Accent: 'Акцент',
  'Editor font size': 'Размер шрифта редактора',
  'Chat font size': 'Размер шрифта чата',
  'Monospace font stack': 'Моноширинный шрифт',
  Language: 'Язык',
  'Working style': 'Стиль работы',
  'Reasoning effort': 'Глубина рассуждений',
  'Max output tokens per turn': 'Максимум токенов ответа',
  Temperature: 'Температура',
  'Custom instructions': 'Свои инструкции',
  'Always allow': 'Всегда разрешать',
  'Always deny': 'Всегда запрещать',
  'Folders outside the workspace': 'Папки вне проекта',
  'Add rule': 'Добавить',
  Add: 'Добавить',
  Remove: 'Удалить',
  Restart: 'Перезапустить',
  'Test connection': 'Проверить подключение',
  'Fetch list': 'Загрузить список',
  'Delete provider': 'Удалить провайдера',
  'Add custom provider': 'Добавить провайдера',
  'API key': 'Ключ API',
  'Base URL': 'Базовый URL',
  'Display name': 'Название',
  'API format': 'Формат API',
  Models: 'Модели',
  'Export to a file…': 'Экспорт в файл…',
  'Import…': 'Импорт…',
  'Check for updates': 'Проверить обновления',
  'Nothing here yet.': 'Пока пусто.',
  'No servers configured.': 'Серверы не настроены.',

  /* Update toast */
  Download: 'Скачать',
  Later: 'Позже',
  'Nothing is downloaded until you say so.': 'Ничего не скачивается без вашего согласия.',
  'Forge will restart to finish installing.': 'Forge перезапустится для установки.',

  /* Status bar */
  working: 'работает',
  unsaved: 'не сохранено',

  /* Agent behaviour + composer styles */
  'Defaults for every model. Individual models can override them.':
    'Значения по умолчанию для всех моделей. Отдельные модели могут их переопределить.',
  'How edits are approved': 'Как подтверждаются правки',
  'Whether shell commands need approval': 'Нужно ли подтверждать команды',
  'Apply, then keep or revert per file': 'Применить, затем принять или откатить по файлам',
  'A dialog with the diff every time': 'Диалог с диффом каждый раз',
  'No prompt, no review screen': 'Без запроса и без экрана проверки',
  'Runs anything without asking': 'Выполняет всё без запроса',
  'style: default': 'стиль: обычный',
  'style: plan': 'стиль: план',
  'style: careful': 'стиль: аккуратно',
  'style: fast': 'стиль: быстро',
  'style: explain': 'стиль: с пояснениями',
  'style: review': 'стиль: разбор',
  'Get the job done': 'Просто сделать работу',
  'Investigate and propose, change nothing': 'Изучить и предложить, ничего не менять',
  'Small steps, verify each one': 'Мелкими шагами, проверяя каждый',
  'Fewest steps to a working result': 'Кратчайший путь к результату',
  'Narrate the reasoning as it goes': 'Объяснять ход мысли',
  'Report findings, change nothing': 'Отчитаться о находках, ничего не менять',
  'Show the model’s thinking in the transcript': 'Показывать размышления модели',
  'Save conversations so they can be reopened later': 'Сохранять диалоги для повторного открытия',
  'Fonts and colours for the editor and the agent panel.':
    'Шрифты и цвета редактора и панели агента.',
  'Open global folder': 'Открыть общую папку',
  'Open project folder': 'Открыть папку проекта',
  'Add your own': 'Добавить свои',
  Reload: 'Обновить',

  /* Wizard */
  'Welcome to Forge': 'Добро пожаловать в Forge',
  Continue: 'Далее',
  'Skip setup': 'Пропустить',
  'Connect a model': 'Подключить модель',
  'Test and continue': 'Проверить и продолжить',
  'Open a project': 'Открыть проект',
  'Choose a folder…': 'Выбрать папку…',
  'Use this one': 'Использовать эту',
  'Start working': 'Начать работу',
  Provider: 'Провайдер',
  'Current folder': 'Текущая папка',
  Appearance_step: 'Внешний вид',
  Model: 'Модель',
  Project: 'Проект',
  Ready: 'Готово',

  /* Chat rail and dashboard */
  Work: 'Работа',
  Layout: 'Раскладка',
  'New task': 'Новая задача',
  Chats: 'Диалоги',
  Dashboard: 'Обзор',
  Plugins: 'Плагины',
  'Editor, file tree and terminal alongside the agent':
    'Редактор, дерево файлов и терминал рядом с агентом',
  'The whole window for the conversation. Same tools either way.':
    'Всё окно под диалог. Инструменты те же самые.',
  'Conversations working right now': 'Диалоги, которые сейчас работают',
  'Working now': 'Сейчас работает',
  'Conversations mid-turn, including ones you have left':
    'Диалоги в процессе ответа, включая те, из которых вы вышли',
  'Nothing running': 'Ничего не выполняется',
  'Waiting for review': 'Ждёт проверки',
  'Edits staged, not yet applied': 'Правки подготовлены, но ещё не применены',
  'No pending edits': 'Нет неприменённых правок',
  'Spent this conversation': 'Потрачено за диалог',
  cached: 'из кэша',
  'Context used': 'Занято контекста',
  estimated: 'оценка',
  'Nothing sent yet': 'Пока ничего не отправлено',
  Repository: 'Репозиторий',
  'Not a repo': 'Не репозиторий',
  'changed files': 'изменённых файлов',
  Clean: 'Чисто',
  'Version control is off for this folder': 'В этой папке нет системы контроля версий',
  'None configured': 'Не настроены',
  'Connected and answering': 'Подключены и отвечают',
  'messages in total': 'сообщений всего',
  Recent: 'Недавние',
  'No conversations in this folder yet.': 'В этой папке ещё нет диалогов.',
  'Search conversations': 'Поиск по диалогам',
  'Loading…': 'Загрузка…',
  'No saved conversations for this folder yet. They are stored per workspace and never inside your repository.':
    'Для этой папки ещё нет сохранённых диалогов. Они хранятся отдельно для каждой папки и никогда не попадают в репозиторий.',
  'Nothing matches': 'Ничего не найдено по запросу',
  Today: 'Сегодня',
  Yesterday: 'Вчера',
  'Previous 7 days': 'Последние 7 дней',
  Older: 'Раньше',
  msg: 'сообщ.',
  Delete: 'Удалить',
  'working…': 'работает…',

  /* Live mode */
  'Live mode': 'Live-режим',
  Sharing: 'Транслируется',
  'The agent can see this and can click and type on it.':
    'Агент это видит и может здесь нажимать и печатать.',
  'The agent can see this. It cannot click or type.':
    'Агент это видит. Нажимать и печатать не может.',
  'actions so far': 'действий пока',
  'Stop sharing': 'Прекратить',
  'What the agent sees': 'Что видит агент',
  'Waiting for the first frame…': 'Жду первый кадр…',
  'What it did': 'Что он сделал',
  'Share a screen or a window with the agent so it can see what you see. Frames are sent to whichever model you have configured, exactly like an image you paste — so share the thing you mean, not the whole desktop, unless you need to.':
    'Покажите агенту экран или окно, чтобы он видел то же, что и вы. Кадры уходят той модели, которую вы настроили, — ровно как вставленная картинка. Поэтому делитесь именно тем, что нужно, а не всем рабочим столом без надобности.',
  'What to share': 'Чем поделиться',
  'Looking for screens…': 'Ищу экраны…',
  'Refresh the list': 'Обновить список',
  screen: 'экран',
  window: 'окно',
  'What it may do': 'Что ему можно',
  'Watch only': 'Только смотреть',
  'It sees the screen and nothing else. It cannot touch anything.':
    'Видит экран и больше ничего. Ничего не трогает.',
  'Watch and control': 'Смотреть и управлять',
  'It can move the mouse, click and type anywhere — not only in this app. Stay at the machine.':
    'Может двигать мышь, нажимать и печатать где угодно, не только в этом приложении. Будьте рядом.',
  'Control drives the real mouse and keyboard. It can click anything that is on screen, including things this app knows nothing about. Nothing starts on its own and closing the app ends it — but while it runs, watch it.':
    'Управление работает настоящими мышью и клавиатурой. Оно может нажать на всё, что есть на экране, включая то, о чём это приложение ничего не знает. Само по себе ничего не запускается, закрытие приложения всё прекращает — но пока идёт, следите.',
  'Share screen': 'Показать экран',
  'Share and allow control': 'Показать и разрешить управление',
  'Live mode is running — click to open it': 'Live-режим работает — нажмите, чтобы открыть',
  'screen + control': 'экран + управление',
  'screen shared': 'экран виден',

  /* Browser */
  Browser: 'Браузер',
  'Built-in browser': 'Встроенный браузер',
  'For looking at what you are building, and for the agent to show you a page. It keeps its own cookies, separate from anything else on this machine.':
    'Чтобы смотреть на то, что вы делаете, и чтобы агент мог показать вам страницу. Куки у него свои, отдельно от всего остального на этом компьютере.',
  'Address, or something to search for': 'Адрес или запрос для поиска',
  Back: 'Назад',
  Forward: 'Вперёд',
  Stop: 'Остановить',
  'Open in your normal browser': 'Открыть в обычном браузере',
  'Could not load that page': 'Не удалось загрузить страницу',

  /* Scheduled tasks */
  'Scheduled tasks': 'Задачи по расписанию',
  'Prompts the agent runs on its own, on a schedule. Each one gets its own conversation you can open and read.':
    'Запросы, которые агент выполняет сам по расписанию. У каждого свой диалог — его можно открыть и прочитать.',
  'Nothing scheduled yet.': 'Пока ничего не запланировано.',
  'A task is just a prompt with a clock attached — "summarise what changed today", "check the build every morning", "look for TODOs left in the code this week".':
    'Задача — это обычный запрос с часами: «подведи итог изменений за день», «проверяй сборку каждое утро», «раз в неделю ищи забытые TODO».',
  'Edit task': 'Изменить задачу',
  'What should it do?': 'Что нужно сделать?',
  'Morning summary': 'Утренняя сводка',
  'Look at what changed in git today and summarise it in a few lines.':
    'Посмотри, что изменилось в git за сегодня, и опиши в нескольких строках.',
  'Written exactly as you would type it in the chat. The agent has the same tools, limited to what you allow below.':
    'Пишется так же, как вы написали бы в чате. Инструменты те же, но ограничены тем, что вы разрешите ниже.',
  Repeat: 'Повторять',
  'On a timer': 'По таймеру',
  'Every N minutes or hours': 'Каждые N минут или часов',
  'Every day': 'Каждый день',
  'At a time you choose': 'В выбранное время',
  'Certain days': 'По дням недели',
  'Weekdays at a set time': 'В выбранные дни в заданное время',
  Once: 'Один раз',
  'A single run, then done': 'Один запуск — и всё',
  'How often': 'Как часто',
  At: 'В',
  When: 'Когда',
  'On these days': 'В эти дни',
  'Every 5 minutes': 'Каждые 5 минут',
  'Every 15 minutes': 'Каждые 15 минут',
  'Every 30 minutes': 'Каждые 30 минут',
  'Every hour': 'Каждый час',
  'Every 2 hours': 'Каждые 2 часа',
  'Every 4 hours': 'Каждые 4 часа',
  'Every 8 hours': 'Каждые 8 часов',
  'Every 12 hours': 'Каждые 12 часов',
  Mon: 'Пн',
  Tue: 'Вт',
  Wed: 'Ср',
  Thu: 'Чт',
  Fri: 'Пт',
  Sat: 'Сб',
  Sun: 'Вс',
  'Allowed to': 'Что разрешено',
  'Read only': 'Только чтение',
  'Cannot change anything. Safe to forget about.':
    'Ничего не меняет. Можно спокойно забыть про неё.',
  'Edit files': 'Править файлы',
  'Writes to the workspace. No commands.': 'Пишет в рабочую папку. Команды запрещены.',
  Everything: 'Всё',
  'Runs commands too, with no prompts. Be sure.':
    'Запускает и команды, без подтверждений. Подумайте дважды.',
  'read only': 'только чтение',
  'can edit files': 'может править файлы',
  'full access': 'полный доступ',
  'Whatever is active': 'Какая выбрана сейчас',
  'Follows the model picker': 'Следует за выбором модели',
  'Notify me when it finishes': 'Уведомить, когда закончит',
  'At this level the task runs commands with no approval, on a schedule, whether or not you are at the machine. Only use it for something you would happily watch run.':
    'На этом уровне задача запускает команды без подтверждения, по расписанию, независимо от того, за компьютером вы или нет. Используйте только для того, за чем не страшно не следить.',
  'Save task': 'Сохранить задачу',
  Cancel: 'Отмена',
  Name: 'Название',
  Enabled: 'Включена',
  'Run now': 'Запустить сейчас',
  'Open the last run': 'Открыть последний запуск',
  'sure?': 'точно?',
  next: 'следующий',
  Failed: 'Ошибка',
  'Finished with nothing to report.': 'Завершено, докладывать нечего.',
  'The run failed.': 'Запуск завершился ошибкой.',
  'Stopped before it finished.': 'Остановлено, не завершив работу.',
  'Ran out of steps': 'Исчерпан лимит шагов',
  'Scheduled task': 'Задача по расписанию',
  'None set up': 'Не созданы',
  'None scheduled': 'Ничего не запланировано',
  'next in': 'через',
  min: 'мин',
  h: 'ч',
  'next tomorrow': 'завтра',
  now: 'сейчас',
  in: 'через',
  tomorrow: 'завтра',
  days: 'дн.',
  Open: 'Открыть',
  Dismiss: 'Закрыть',

  /* Account */
  Account: 'Аккаунт',
  'Your display name': 'Ваше отображаемое имя',
  'Set your name': 'Укажите имя',
  'Who you are inside the app, and the services the agent is allowed to act on your behalf with.':
    'Кто вы внутри приложения и какие сервисы агент может использовать от вашего имени.',
  'Your name': 'Ваше имя',
  'Shown in the profile menu. Stored on this machine only — it is never sent to a model or anywhere else.':
    'Показывается в меню профиля. Хранится только на этом компьютере — не уходит ни модели, ни куда-либо ещё.',
  'Personal access token': 'Персональный токен доступа',
  Link: 'Привязать',
  Unlink: 'Отвязать',
  'Checking…': 'Проверяю…',
  'Create a token on GitHub': 'Создать токен на GitHub',
  'with the scopes you are willing to grant, then paste it here. Forge checks it against GitHub and stores it encrypted by your OS keychain, alongside your API keys.':
    'с теми правами, которые готовы выдать, и вставьте его сюда. Forge проверит токен в GitHub и сохранит его зашифрованным в хранилище ключей ОС — там же, где ключи API.',
  'Once linked, every command the agent runs sees GH_TOKEN and GITHUB_TOKEN, so `gh` and `git push` work without asking you to authenticate again. Revoke the token on GitHub to cut that off instantly.':
    'После привязки каждая команда агента видит GH_TOKEN и GITHUB_TOKEN, поэтому `gh` и `git push` работают без повторной авторизации. Отзовите токен на GitHub — доступ пропадёт сразу.',
  'Not available. Google sign-in needs a registered OAuth client and a server to receive the callback, and Forge has neither by design — nothing about you leaves this machine. To let the agent reach a Google service, add its MCP server under MCP servers instead.':
    'Недоступно. Вход через Google требует зарегистрированного OAuth-клиента и сервера для приёма ответа, а у Forge нет ни того, ни другого — и это осознанно: никакие ваши данные не покидают компьютер. Чтобы агент мог работать с сервисом Google, добавьте его MCP-сервер в разделе MCP-серверы.',

  /* Appearance */
  'Interface scale': 'Масштаб интерфейса'
}

const DICTIONARIES: Record<Language, Record<string, string>> = { en: {}, ru: RU }

/**
 * Translate. Falls back to the source string, so anything not yet in the
 * dictionary simply stays English instead of breaking the layout.
 */
export function translate(language: Language, text: string): string {
  return DICTIONARIES[language]?.[text] ?? text
}

/** Hook form, for components. */
export function useT(): (text: string) => string {
  const language = useStore((state) => state.settings.language)
  return (text: string) => translate(language, text)
}

export const LANGUAGES: Array<{ id: Language; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'ru', label: 'Русский' }
]
