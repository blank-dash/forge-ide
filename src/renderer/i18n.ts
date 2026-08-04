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
  'working': 'работает',
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
  Ready: 'Готово'
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
