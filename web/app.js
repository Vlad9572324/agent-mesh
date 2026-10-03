(() => {
  "use strict";

  // Application text is an English canonical message plus captured, unmodified data
  // values. Only explicitly owned text nodes/attributes are refreshed in place.
  // Locale changes never rebuild forms, reconnect transports or alter drafts.
  let language = new URLSearchParams(location.search).get("lang") === "ru" ? "ru" : "en";
  const localeName = () => language === "ru" ? "ru-RU" : "en-US";
  const RU_MESSAGES = {
    "Key issued": "Ключ выдан",
    "Delivery alerts": "Уведомления о доставке",
    "Delivery monitoring is off": "Проверка сроков доставки выключена",
    "Configure deadlines": "Настроить сроки",
    "Checking delivery deadlines…": "Проверяем сроки доставки…",
    "Delivery status unavailable": "Статус доставки недоступен",
    "No overdue messages in the latest check": "В последней проверке просроченных сообщений нет",
    "{0} overdue recipient deliveries": "Просроченных доставок адресатам: {0}",
    "Last checked: {0}": "Последняя проверка: {0}",
    "Monitoring is disabled until an owner saves enabled settings.": "Проверка выключена, пока владелец явно не сохранит включённые настройки.",
    "The current delivery state is unknown. Refresh to check again.": "Текущее состояние доставки неизвестно. Обновите данные для новой проверки.",
    "No acknowledgement by the deadline": "Нет подтверждения к установленному сроку",
    "No direct reply by the deadline": "Нет прямого ответа к установленному сроку",
    "Message {0} · #{1} · project {2}": "Сообщение {0} · #{1} · проект {2}",
    "{0} → {1} · sent {2} · deadline {3}": "{0} → {1} · отправлено {2} · срок {3}",
    "Open message": "Открыть сообщение",
    "No report": "Нет отчёта",
    "Adapter delivered": "Доставка подтверждена адаптером",
    "Adapter accepted": "Приём подтверждён адаптером",
    "Direct reply recorded": "Прямой ответ записан",
    "{0} loaded · {1} currently overdue in this window · checked {2}": "Загружено {0} · сейчас просрочено в этом окне: {1} · проверено {2}",
    "Deadlines through {0}": "Сроки до {0}",
    "Updates available. Refresh the list when ready; the displayed rows are from its previous check.": "Есть обновления. Обновите список, когда удобно; показанные строки относятся к предыдущей проверке.",
    "The displayed list is not current. Refresh to verify its status.": "Показанный список не подтверждён как актуальный. Обновите его для проверки.",
    "No overdue messages were returned by this check.": "В этой проверке просроченных сообщений нет.",
    "Delivery alerts have not been loaded yet.": "Уведомления о доставке ещё не загружены.",
    "Settings saved. New addressed messages are monitored from the enabled time.": "Настройки сохранены. Новые адресные сообщения проверяются с момента включения.",
    "Settings saved. Deadline monitoring is off.": "Настройки сохранены. Проверка сроков выключена.",
    "Settings changed on the server. Your draft is preserved; replace it with current settings before saving again.": "Настройки изменились на сервере. Черновик сохранён; замените его текущими настройками перед новой записью.",
    "Saving deadlines… The request is not retried automatically.": "Сохраняем сроки… Запрос не повторяется автоматически.",
    "Saving was not confirmed. Reload server settings before trying again; your draft is preserved.": "Сохранение не подтверждено. Перед новой попыткой загрузите настройки сервера; черновик сохранён.",
    "Server settings loaded. Monitoring changes only when you save.": "Настройки сервера загружены. Проверка изменится только после сохранения.",
    "Enter an acknowledgement deadline of 1–1440 minutes and an optional reply deadline between that value and 10080 minutes, to the nearest second.": "Укажите срок подтверждения от 1 до 1440 минут и, при необходимости, срок ответа не меньше него и до 10080 минут, с точностью до секунды.",
    "The alert list changed. Refresh it before loading another page.": "Список уведомлений изменился. Обновите его перед загрузкой следующей страницы.",
    "Message access or identity changed. Reload the alert list.": "Доступ к сообщению или его данные изменились. Обновите список уведомлений.",
    "GUI read positions": "Отметки прочтения в интерфейсе",
    "{0} unread": "{0} непрочитанных",
    "All caught up": "Всё прочитано",
    "Checking messages…": "Проверяем сообщения…",
    "Across {0} channels · open next →": "В {0} каналах · открыть →",
    "New replies will appear here": "Новые ответы появятся здесь",
    "{0} unread messages": "Непрочитанных сообщений: {0}",
    "Checking activity…": "Проверяем активность…",
    "No messages yet": "Сообщений пока нет",
    "Recent discussion": "Свежее обсуждение",
    "Last message {0}": "Сообщение {0}",

    "Select a project with an available communication channel.": "Выберите проект с доступным каналом для общения.",
    "Read and write: {0} channel(s). The connector starts in an empty folder on the agent’s computer.": "Чтение и запись: {0} каналов. Коннектор запускается в пустой папке на компьютере агента.",
    "Select 1 to 8 channels for the new agent.": "Выберите хотя бы один канал для нового агента (не более 8).",
    "Connection address: {0}": "Адрес подключения: {0}",
    "Connection generation is unavailable. Configure the server’s public HTTPS address and CA certificate.": "Генератор подключения недоступен. Настройте публичный HTTPS-адрес и сертификат CA на сервере.",
    "Awaiting connection": "Ожидает подключения",
    "Connected": "Подключён",
    "Expired": "Истекло",
    "Revoked": "Отозвано",
    "{0} · {1} · expires {2}": "{0} · {1} · действует до {2}",
    "New command…": "Новая команда…",
    "Revoke invitation…": "Отозвать приглашение…",
    "No invitations yet.": "Приглашений пока нет.",
    "Agent {0}. Use once before {1}.": "Агент {0}. Одноразовое подключение до {1}.",
    "Generate a new command for {0}? Previous unused invitations for this agent will stop working. Lifetime: {1} hours.": "Сформировать новую команду для {0}? Прежние неиспользованные приглашения этого агента перестанут работать. Срок: {1} ч.",
    "Revoke the unused invitation for {0}? The account and its configured permissions will remain.": "Отозвать неиспользованное приглашение для {0}? Учётная запись и настроенные права останутся.",
    "New connection command generated.": "Новая команда подключения сформирована.",
    "Invitation revoked.": "Приглашение отозвано.",
    "Agent created. Copy the connection command shown once.": "Агент создан. Скопируйте команду подключения — она показывается один раз.",
    "Command copied. Share it only with this agent.": "Команда скопирована. Передайте её только этому агенту.",
    "Automatic copying is unavailable. Copy the selected command manually.": "Автоматическое копирование недоступно. Скопируйте выделенную команду вручную.",
    "Onboarding invitations": "Приглашения для подключения",
    "Start prompt": "Стартовый промпт",
    "Optional skill": "Необязательный навык",
    "Hooks and tools": "Хуки и инструменты",
    "Loaded automatically when the connection starts a new CLI session.": "Загружается автоматически при запуске новой CLI-сессии через подключение.",
    "Install manually only if useful; see the installation locations in HOOKS-AND-TOOLS.md.": "Устанавливайте вручную при необходимости; расположения для установки указаны в HOOKS-AND-TOOLS.md.",
    "Setup, inbox polling and delivery reports. Hooks and MCP are configured for each launch.": "Настройка, проверка входящих и отчёты о доставке. Хуки и MCP настраиваются для каждого запуска.",
    "Checking guide files…": "Проверяем файлы инструкций…",
    "Guide files are unavailable from this server. You can still use the connection command.": "Этот сервер не предоставил файлы инструкций. Командой подключения по-прежнему можно пользоваться.",
    "Guide files failed validation. Copying and downloading them are unavailable; the connection command is separate.": "Файлы инструкций не прошли проверку. Их копирование и скачивание недоступны; команда подключения находится отдельно.",
    "English originals · SHA-256 checked against API metadata.": "Английские оригиналы · SHA-256 сверены с метаданными API.",
    "Copy text": "Копировать текст",
    "Download {0}": "Скачать {0}",
    "Copied {0}. No connection command was included.": "Скопирован {0}. Команда подключения в него не включена.",
    "Automatic copying is unavailable. Copy the selected document manually.": "Автоматическое копирование недоступно. Скопируйте выделенный документ вручную.",
    "Requested CLI": "Выбранный CLI",
    "Agent": "Агент",
    "Auto · chosen locally on first run": "Автоматически · определяется локально при первом запуске",
    "Invitation scope · verify current access with link_status after connecting.": "Область приглашения · после подключения проверьте текущий доступ через link_status.",

    " {0} technical relationships hidden. Turn on “Show technical events” to view them.": " Технических связей скрыто: {0}. Включите «Показывать технические события», чтобы увидеть их.",
    "Only technical relationships are loaded for this entity. Turn on “Show technical events” to view them.": "Для этой сущности загружены только технические связи. Включите «Показывать технические события», чтобы увидеть их.",
    "{0} technical events hidden in this loaded window. No records were deleted; earlier events may be outside the window.": "Технических событий скрыто в загруженном окне: {0}. Записи не удалены; более ранние события могут находиться за пределами окна.",
    "All event types are shown in this loaded window. Earlier events may be outside the window.": "В загруженном окне показаны все типы событий. Более ранние события могут находиться за пределами окна.",
    "Only technical events are loaded. Turn on “Show technical events” to view them.": "Загружены только технические события. Включите «Показывать технические события», чтобы увидеть их.",
    "{0} technical entities hidden in this loaded sample. Counts above include them; select their type or show technical events to view them.": "Технических сущностей скрыто в загруженной выборке: {0}. Счётчики выше учитывают их; выберите нужный тип или включите показ технических событий.",
    "All matching entity types are shown in this loaded sample. Entities outside the sample are not shown.": "В загруженной выборке показаны все подходящие типы сущностей. Сущности вне выборки не показаны.",
    "Only technical entities match in this loaded sample. Select their type or show technical events to view them.": "В загруженной выборке подходят только технические сущности. Выберите их тип или включите показ технических событий.",
    "{0} reports loaded; {1} visible. {2}Up to 200 most recently loaded reports are retained. {3}The cursor also includes messages and receipts; it is not a completed-task count.": "Загружено отчётов: {0}; показано: {1}. {2}Сохраняются до 200 последних загруженных отчётов. {3}Курсор также учитывает сообщения и подтверждения; это не число выполненных задач.",
    "Selected project": "Выбранный проект",
    "Message {0}": "Сообщение {0}",
    "Delivery status · {0}": "Статус доставки · {0}",
    "Session lease {0}": "Аренда сессии {0}",
    "Task run {0}": "Запуск задачи {0}",
    "Artifact {0} · {1}": "Артефакт {0} · {1}",
    "Project member": "Участник проекта",
    "In project": "В проекте",
    "Channel member": "Участник канала",
    "In channel": "В канале",
    "Message author": "Автор сообщения",
    "Publication author": "Автор публикации",
    "Recipient": "Получатель",
    "Recipient delivery status": "Статус доставки получателю",
    "Message recipient": "Получатель сообщения",
    "CLI report author": "Автор отчёта CLI",
    "Task event author": "Автор события задачи",
    "Message report": "Отчёт о сообщении",
    "Lease account": "Учётная запись аренды",
    "Assigned task owner": "Назначенный исполнитель",
    "Assigned reviewer": "Назначенный проверяющий",
    "Task creator": "Создатель задачи",
    "Task run": "Запуск задачи",
    "Task event": "Событие задачи",
    "Run event": "Событие запуска",
    "Run review request": "Запрос проверки запуска",
    "Review request response": "Ответ на запрос проверки",
    "Published artifact reference": "Опубликованная ссылка на артефакт",
    "External report artifact": "Артефакт внешнего отчёта",
    "Current version author": "Автор текущей версии",
    "Memory version": "Версия памяти",
    "Note source": "Источник заметки",
    "Projects": "Проекты",
    "Participants": "Участники",
    "Channels": "Каналы",
    "Messages": "Сообщения",
    "Receipts": "Подтверждения",
    "Tasks": "Задачи",
    "Task runs": "Этапы работы",
    "Events / review": "События / ревью",
    "Artifacts": "Артефакты",
    "Document": "Документ",
    "Use a single-line title without control characters.": "Название должно быть одной строкой без управляющих символов.",
    "Memory": "Память",
    "Memory versions": "Версии памяти",
    "Notes": "Заметки",
    "Session leases": "Аренды сессий",
    "CLI reports": "Отчёты CLI",
    "Project": "Проект",
    "Participant": "Участник",
    "Account type": "Тип учётной записи",
    "Channel": "Канал",
    "Author": "Автор",
    "Report author": "Автор отчёта",
    "Reply to message": "Ответ на сообщение",
    "Recipients": "Адресаты",
    "Channel sequence": "Порядок в канале",
    "Created": "Создано",
    "Updated": "Обновлено",
    "Message": "Сообщение",
    "Session ID from this record": "ID сессии из этой записи",
    "Delivery reported": "Сообщено о доставке",
    "Acceptance reported": "Сообщено о приёме",
    "Uncertainty recorded": "Отмечена неопределённость",
    "Event type": "Тип события",
    "Run / execution ID from this record": "ID этапа / запуска из записи",
    "Role": "Роль",
    "Lease expiry": "Срок аренды",
    "Closed": "Закрыто",
    "Task": "Задача",
    "Assignee": "Исполнитель",
    "Independent reviewer": "Отдельный ревьюер",
    "Created by": "Создал",
    "Current task run": "Текущий этап задачи",
    "Published state": "Опубликованное состояние",
    "Version": "Версия",
    "Review request": "Запрос ревью",
    "External verification report": "Внешний отчёт проверки",
    "Explicit artifact references": "Явные ссылки на артефакты",
    "Bytes": "Байты",
    "Memory entry": "Запись памяти",
    "Version author": "Автор версии",
    "Source message": "Сообщение-источник",
    "Reviewer decision": "Решение ревьюера",
    "Verification artifact": "Артефакт проверки",
    "Tasks and review": "Задачи и ревью",
    "Project memory": "Память проекта",
    "Sessions": "Сессии",
    "Unknown participant": "Неизвестный участник",
    "no data": "нет данных",
    "unknown time": "неизвестное время",
    "The request was cancelled or exceeded 15 seconds. Check the connection and try again.": "Запрос отменён или превысил 15 секунд. Проверьте связь и повторите.",
    "The service is unavailable. Check your network and HTTPS certificate trust. Data has not been updated.": "Сервис недоступен: проверьте сеть и доверие HTTPS-сертификату. Данные не обновлены.",
    "Null characters are not allowed.": "Нулевой символ недопустим.",
    "Text is too long: {0} UTF-8 bytes, limit {1}. Shorten the text.": "Слишком длинный текст: {0} байт UTF-8 при лимите {1}. Сократите текст.",
    "Enter text, not just whitespace.": "Добавьте текст, а не только пробелы.",
    "{0} / {1} UTF-8 bytes{2}": "{0} / {1} байт UTF-8{2}",
    "Data refresh unconfirmed · retry via stream or 8-second polling": "Обновление данных не подтверждено · повтор по потоку или опросу 8 с",
    "Connected · workspace-wide live updates": "На связи · живые обновления всего пространства",
    "Stream interrupted · reconnecting · 8-second fallback polling": "Поток прерван · переподключение · резервный опрос 8 с",
    "Connecting live stream · 8-second fallback polling": "Подключение живого потока · резервный опрос 8 с",
    "Synced: {0}": "Синхронизация: {0}",
    "No connection with a personal access key.": "Подключение с личным ключом отсутствует.",
    "The JSON-encoded request exceeds the size limit. Reduce its content.": "Запрос превышает допустимый размер после JSON-кодирования. Сократите содержимое.",
    "The key is invalid or revoked. All data and the key have been cleared from this tab.": "Ключ недействителен или отозван. Все данные и ключ удалены из этой вкладки.",
    "Authentication has ended.": "Авторизация завершена.",
    "Invalid request. Check the fields and recipients.": "Некорректный запрос. Проверьте поля и получателей.",
    "This account does not have permission to perform that action.": "У этой учётной записи нет права выполнить действие.",
    "The resource was not found or is unavailable to this account. This is an access error, not an empty list.": "Ресурс не найден или недоступен вашей учётной записи. Это ошибка доступа, не пустой список.",
    "Conflict: the server rejected the change. Retrying unchanged content is safe; different content requires a new request.": "Конфликт: сервер отклонил изменение. Повтор с тем же содержимым безопасен; для другого содержимого нужен новый запрос.",
    "Content exceeds the size limit.": "Содержимое превышает допустимый размер.",
    "Too many requests. Try again later.": "Слишком много запросов. Повторите позже.",
    "The service returned an error. Data is unconfirmed.": "Сервис вернул ошибку. Данные не подтверждены.",
    "The artifact exceeds 2 MiB.": "Артефакт превышает 2 МиБ.",
    "New message": "Новое сообщение",
    "Select a project": "Выберите проект",
    "Not connected": "Нет подключения",
    "Personal access key required": "Требуется личный ключ",
    "Access is checked by the server": "Доступ проверяет сервер",
    "Select an available project and channel.": "Выберите доступный проект и канал.",
    "Show": "Показать",
    "Connect": "Подключиться",
    "Project overview": "Обзор проекта",
    " · archived": " · архив",
    "Refresh could not be confirmed. Showing the last received snapshot, not the current state.": "Не удалось подтвердить обновление. Показан последний полученный снимок; это не текущее состояние.",
    "No snapshot received yet: refresh is unconfirmed.": "Снимок ещё не получен: обновление не подтверждено.",
    "Loading available tasks and sessions…": "Загружаем доступные задачи и сессии…",
    "Refresh of {0} is unconfirmed. Previous values may be stale; “—” means no data has been received. Other available sections have been updated.": "Обновление {0} не подтверждено. Предыдущие значения могут быть устаревшими; «—» означает, что данных ещё нет. Остальные доступные разделы обновлены.",
    "tasks": "задач",
    "sessions": "сессий",
    " and ": " и ",
    "Snapshot {0} · {1}{2} fresh session leases, not an indication of model activity. ": "Снимок {0} · {1}{2} свежих аренд сессий, не показатель работы моделей. ",
    "Tasks: latest 1,000; overview is incomplete. ": "Задачи: последние 1000, обзор неполный. ",
    "Only data available to you. View deliveries and CLI activity inside channels.": "Только доступные вам данные. Доставки и активность CLI смотрите внутри каналов.",
    "Task states have not been confirmed yet.": "Состояния задач ещё не подтверждены.",
    "The last snapshot contained no such tasks. Refresh is unconfirmed.": "В последнем снимке таких задач не было. Обновление не подтверждено.",
    "No loaded tasks are awaiting review, requesting changes, or marked uncertain.": "В загруженных задачах нет ожидания ревью, запросов изменений или неопределённости.",
    "Showing 8 of {0}. The rest are under All tasks.": "Показано 8 из {0}. Остальные — в разделе «Все задачи».",
    "No tasks yet. They will appear after project participants publish them.": "Задач пока нет. Они появятся после публикации участниками проекта.",
    "Task read is unconfirmed…": "Чтение задач не подтверждено…",
    "Showing 6 of {0}. Open Tasks and review for the full list.": "Показано 6 из {0}. Откройте «Задачи и ревью» для полного списка.",
    "No visible participants yet.": "Видимых участников пока нет.",
    "Reading participants…": "Чтение участников…",
    "Can send messages": "Можно отправлять сообщения",
    "Read-only view": "Только просмотр",
    " · new events": " · есть новые события",
    "No available channels yet. The workspace owner grants access.": "Доступных каналов пока нет. Права выдаёт владелец пространства.",
    "Checking channel access…": "Проверяем доступ к каналам…",
    "Close navigation": "Закрыть навигацию",
    "Open navigation": "Открыть навигацию",
    " · updates available": " · есть обновления",
    "Checking access…": "Проверка доступа…",
    "No available channels": "Нет доступных каналов",
    "Channel access has not been confirmed yet": "Доступ к каналам ещё не подтверждён",
    "Administration": "Администрирование",
    "No available projects": "Нет доступных проектов",
    "Overview": "Обзор",
    "Project map": "Карта проекта",
    "Project CLI feed": "Общая лента CLI",
    "Discussion": "Обсуждение",
    "Events": "События",
    "CLI activity": "Активность CLI",
    "● Fresh adapter heartbeat": "● Свежий heartbeat адаптера",
    "◷ Heartbeat is stale": "◷ Heartbeat устарел",
    "○ Heartbeat unknown": "○ Heartbeat неизвестен",
    "Viewer · no heartbeat": "Наблюдатель · без heartbeat",
    "Self-report: {0}": "Самоотчёт: {0}",
    "No activity self-report": "Самоотчёт активности отсутствует",
    "Last heartbeat: {0}\nID: {1}{2}": "Последний heartbeat: {0}\nID: {1}{2}",
    "Adapter session: {0}": "Сессия адаптера: {0}",
    "Loading participants…": "Загрузка участников…",
    "The API returned no visible participants.": "API не вернул видимых участников.",
    "Participant data has not been received yet.": "Данные об участниках ещё не получены.",
    "No other available agents in this channel.": "Нет других доступных агентов в этом канале.",
    "Reply to ID {0} · not a new automatic invocation": "Ответ на ID {0} · не новый автоматический вызов",
    "⚠ uncertain": "⚠ неопределённо",
    "accepted, not necessarily completed": "принято, не означает выполнено",
    "delivered": "доставлено",
    "stored, delivery unconfirmed": "сохранено, доставка не подтверждена",
    "viewed · connector report": "просмотрено · по отчёту коннектора",
    "accepted, not necessarily completed · connector report": "принято, не обязательно выполнено · по отчёту коннектора",
    "offered to the CLI · connector report": "предложено CLI · по отчёту коннектора",
    "Legacy: {0}": "Подтверждение адаптера: {0}",
    "Legacy confirmations": "Подтверждения адаптера",
    "Connector reports": "Отчёты коннектора",
    "No connector report": "Нет отчёта коннектора",
    "Connector reports have not been loaded yet.": "Отчёты коннектора ещё не загружены.",
    "connector status unavailable": "статус коннектора недоступен",
    "Connector reports are unavailable; native status is unknown.": "Статус коннектора недоступен: отчёты не удалось получить.",
    "Offered to the CLI": "Предложено CLI",
    "Viewed": "Просмотрено",
    "Reported acceptance": "Сообщено о приёме",
    "According to the connector; not independently verified by the server. Times show the first server record of each report. Offered, viewed and accepted are separate reports; none proves completion.": "По отчёту коннектора; сервер независимо не проверял действие. Время показывает первую запись каждого отчёта сервером. Предложение, просмотр и приём — отдельные отчёты; ни один не доказывает выполнение.",
    "Stored in the channel · no adapter invocation": "Сохранено в канале · без вызова адаптера",
    "ID {0} · seq {1} · stored {2}": "ID {0} · seq {1} · сохранено {2}",
    "Stored": "Сохранено",
    "Delivered": "Доставлено",
    "Accepted": "Принято",
    "Uncertain": "Неопределённо",
    "unconfirmed": "не подтверждено",
    "Operator review is required. Automatic execution retry is unconfirmed.": "Нужна проверка оператором. Автоматический повтор выполнения не подтверждён.",
    "Receipt session: {0}": "Сессия подтверждения: {0}",
    "No recipients · stored in the channel without an automatic adapter invocation": "Без адресатов · сохранено в канале, без автоматического вызова адаптера",
    "Reply ↗": "Ответить ↗",
    "Loading messages…": "Загрузка сообщений…",
    "Messages have not been received yet. Check the connection status.": "Сообщения ещё не получены. Проверьте состояние подключения.",
    "No matches in loaded messages.": "В загруженных сообщениях совпадений нет.",
    "No messages in this channel yet.": "В этом канале пока нет сообщений.",
    "Message stored": "Сообщение сохранено",
    "Delivery confirmed": "Подтверждена доставка",
    "Acceptance confirmed": "Подтверждён приём",
    "CLI activity report stored · details in a separate tab": "Сохранён отчёт активности CLI · подробности в отдельной вкладке",
    "#{0} · {1} · seq {2}\nEntity: {3}": "#{0} · {1} · seq {2}\nОбъект: {3}",
    "Loading events…": "Загрузка событий…",
    "No events received for this channel yet.": "Полученных событий этого канала пока нет.",
    "Events have not been received yet.": "События ещё не получены.",
    "Only #{0}. Showing up to 200 events received in this view.": "Только #{0}. Показано до 200 полученных событий текущего просмотра.",
    "No channel selected.": "Канал не выбран.",
    "PROJECT NOTE · VERSION {0} · IMMUTABLE": "ЗАМЕТКА ПРОЕКТА · ВЕРСИЯ {0} · БЕЗ РЕДАКТИРОВАНИЯ",
    "{0} · {1}\nProject: {2} ({3}) · ID {4}": "{0} · {1}\nПроект: {2} ({3}) · ID {4}",
    "Source: message ID {0}": "Источник: сообщение ID {0}",
    "Loading notes…": "Загрузка заметок…",
    "No published notes in this project yet.": "В этом проекте пока нет опубликованных заметок.",
    "Notes have not been received yet.": "Заметки ещё не получены.",
    "Destination: the entire project “{0}” ({1}).": "Назначение: весь проект «{0}» ({1}).",
    "No project selected.": "Проект не выбран.",
    "Available channels have changed. The previous map has been cleared.": "Доступный состав каналов изменился. Предыдущая карта очищена.",
    "The API returned an invalid project map snapshot. Relationships are unconfirmed.": "API вернул некорректный снимок карты проекта. Связи не подтверждены.",
    "Open project overview": "Открыть обзор проекта",
    "Open discussion channel": "Открыть канал обсуждения",
    "Open this channel’s CLI feed": "Открыть ленту CLI этого канала",
    "Open task and history": "Открыть задачу и историю",
    "Open memory and versions": "Открыть память и версии",
    "Open artifacts section": "Открыть раздел артефактов",
    "Open project notes": "Открыть заметки проекта",
    "Open session leases": "Открыть аренды сессий",
    "Open another task and discard the current unpublished event draft?": "Открыть другую задачу и закрыть текущий черновик события без публикации?",
    "Open another memory entry and discard the current unpublished draft?": "Открыть другую запись памяти и закрыть текущий черновик без публикации?",
    "Select an entity from the loaded snapshot.": "Выберите сущность из загруженного снимка.",
    "A client report, not server verification. A CLI session ID is not joined to a session lease or legacy receipt.": "Клиентский отчёт, не серверная проверка. ID сессии CLI не связывается с арендой сессии или legacy-подтверждением.",
    "A lease does not prove model activity. Its run_id is a client label, not a task-run reference.": "Аренда не доказывает работу модели. Её run_id — клиентская метка, не ссылка на этап задачи.",
    "A receipt or published report is not independent server verification of completion.": "Подтверждение или опубликованный отчёт не является независимой проверкой выполнения сервером.",
    "No relationships among the loaded entities. This does not establish that no relationships exist beyond this bounded snapshot.": "Нет связей среди загруженных объектов. Это не доказывает отсутствие связей за пределами ограниченного снимка.",
    "Showing {0} of {1} relationships for the selected entity among loaded entities. Entities outside the sample and their relationships are not shown.": "Показано {0} из {1} связей выбранной сущности среди загруженных объектов. Узлы вне выборки и связи с ними здесь не показаны.",
    "In project “{0}”": "В проекте «{0}»",
    "Refresh is unconfirmed. Previous snapshot: {0}": "Обновление не подтверждено. Предыдущий снимок: {0}",
    "No snapshot received; absence of entities has not been established.": "Снимок не получен; отсутствие сущностей не установлено.",
    "{0}Snapshot: {1}": "{0}Снимок: {1}",
    "Updating… ": "Обновляем… ",
    "Reading the authorized project map…": "Читаем разрешённую карту проекта…",
    "{0} Counts include only data available to you. The map loads at most 25 entities of each type; relationships are shown only between loaded entities. A missing map edge does not establish that the relationship is absent from the project. Access, keys, and audit above are explanatory concepts, not records in this snapshot.": "{0} Количества относятся только к разрешённым вам данным. Карта загружает не более 25 объектов каждого типа; связи показаны только между загруженными объектами. Отсутствие связи на карте не означает её отсутствия в проекте. Права, ключи и аудит выше — пояснительная схема, не записи этого снимка.",
    "{0} of {1}": "{0} из {1}",
    "Refresh unconfirmed": "Не подтверждено обновлением",
    "Bounded sample": "Выборка ограничена",
    "Within your access scope": "В доступной области",
    "Not received yet": "Ещё не получено",
    "All types": "Все типы",
    "Data is unconfirmed; a zero count has not been established.": "Данные не подтверждены; нулевое количество не установлено.",
    "Loading metadata…": "Загружаем метаданные…",
    "No matches in the loaded snapshot. Search does not cover entities outside the sample.": "В загруженном снимке совпадений нет. Поиск не охватывает объекты вне выборки.",
    "No entities of this type in the loaded sample.": "В загруженной выборке этого типа объектов нет.",
    "Listing {0} of {1} matching snapshot entities.{2}": "В списке {0} из {1} совпавших объектов снимка.{2}",
    " Select a type or refine the search: the list is limited to 100 rows.": " Выберите тип или уточните поиск: список ограничен 100 строками.",
    "All available agents": "Все доступные агенты",
    "All available channels": "Все доступные каналы",
    "Available project membership has changed. The old window was cleared; rereading permitted events.": "Доступный состав проекта изменился. Старое окно очищено; перечитываем разрешённые события.",
    "CLI session started": "Начало сессии CLI",
    "CLI session ended": "Завершение сессии CLI",
    "Turn started": "Начало хода",
    "Turn completed": "Завершение хода",
    "Tool started": "Запуск инструмента",
    "Tool completed": "Завершение инструмента",
    "Tool failed": "Ошибка инструмента",
    "Adapter waiting": "Ожидание адаптера",
    "Message offered to CLI": "Сообщение предложено CLI",
    "CLI reported message viewed": "CLI сообщил о просмотре сообщения",
    "CLI reported message acceptance": "CLI сообщил о приёме сообщения",
    "Client report": "Клиентский отчёт",
    "Client-reported · not server-verified": "Сообщено клиентом · не проверено сервером",
    "Stored: {0}": "Сохранено: {0}",
    "Tool: {0}": "Инструмент: {0}",
    "Event identifiers": "Идентификаторы события",
    "ID {0}\nAgent: {1} · channel: {2}\nCLI session: {3}{4}": "ID {0}\nАгент: {1} · канал: {2}\nСессия CLI: {3}{4}",
    "\nRelated message: {0}": "\nСвязанное сообщение: {0}",
    "Turn completion does not confirm task completion or passing checks.": "Завершение хода не подтверждает выполнение задачи или прохождение проверок.",
    "Offered does not mean accepted by the model. Delivery and legacy receipts are tracked separately.": "Предложено — не значит принято моделью. Доставка и legacy-подтверждения учитываются отдельно.",
    "Viewed does not mean accepted or completed; legacy receipts are unchanged.": "Просмотрено — не значит принято или выполнено; legacy-подтверждения не меняются.",
    "An acceptance report is not proof of completion.": "Отчёт о приёме — не доказательство выполнения.",
    "Last event: data has not been confirmed yet.": "Последнее событие: данные ещё не подтверждены.",
    "Last event: refresh is unconfirmed. The previous snapshot was empty; current absence of events has not been established.": "Последнее событие: обновление не подтверждено. Предыдущий снимок был пуст; текущее отсутствие событий не установлено.",
    "Last event: no reports in the selected scope. This does not mean the agent has stopped.": "Последнее событие: в выбранной области отчётов нет. Это не означает, что агент остановлен.",
    "Last event in the selected scope: ": "Последнее событие в выбранной области: ",
    " · refresh unconfirmed; timestamp is from the previous snapshot.": " · обновление не подтверждено; время из последнего снимка.",
    " · no fresh events in the last 5 minutes. This does not mean the agent has stopped.": " · нет свежих событий за последние 5 минут. Это не означает остановку агента.",
    " · report stored less than 5 minutes ago; not confirmation of model activity.": " · отчёт сохранён менее 5 минут назад; это не подтверждение работы модели.",
    "Project “{0}” · {1} · {2}. {3}": "Проект «{0}» · {1} · {2}. {3}",
    "selected channel": "выбранный канал",
    "all available channels": "все доступные каналы",
    "selected agent": "выбранный агент",
    "all authors of permitted events": "все авторы разрешённых событий",
    "Feed read is unconfirmed. See the error above; absence of events has not been established.": "Чтение ленты не подтверждено. Ошибка указана выше; отсутствие событий не установлено.",
    "No CLI reports in the selected scope yet. This does not mean the agent has stopped: the adapter may not publish events, or the filter may match no reports.": "В выбранной области отчётов CLI пока нет. Это не означает, что агент остановлен: адаптер может не публиковать события или выбран фильтр без отчётов.",
    "Reading the project CLI feed…": "Чтение общей ленты CLI…",
    "{0}{1}{2} Live refresh rereads a window of up to 200 events; this is not the entire archive.": "{0}{1}{2} При живом обновлении перечитывается окно до 200 событий; это не весь архив.",
    "Updating the window… ": "Обновляем окно… ",
    "Refresh is unconfirmed. ": "Обновление не подтверждено. ",
    "Showing {0} events, newest first. {1}{2}": "Показано {0} событий, новые сверху. {1}{2}",
    "Snapshot: {0}. ": "Снимок: {0}. ",
    "The 200-event limit has been reached. Earlier events remain on the server; refine the filters.": "Достигнут предел 200 событий. Более ранние остаются на сервере; уточните фильтры.",
    "Earlier events are available.": "Есть более ранние события.",
    "No earlier events in this snapshot.": "Более ранних событий в этом снимке нет.",
    "The first snapshot has not been received yet.": "Первый снимок ещё не получен.",
    "Limit: 200 events": "Предел: 200 событий",
    "Load earlier events": "Загрузить более ранние",
    "The API returned an invalid page of the project CLI feed.": "API вернул некорректную страницу общей ленты CLI.",
    "The API returned an incorrect scope or attribution for the project CLI feed.": "API вернул неверную область или атрибуцию общей ленты CLI.",
    "CLI session start reported": "Сообщено о начале сессии CLI",
    "CLI session end reported": "Сообщено о завершении сессии CLI",
    "Turn start reported": "Сообщено о начале хода",
    "Turn completion reported": "Сообщено о завершении хода",
    "Tool start observed": "Наблюдался запуск инструмента",
    "Tool completion observed": "Наблюдалось завершение инструмента",
    "Tool failure reported": "Сообщено об ошибке инструмента",
    "Adapter reports waiting": "Адаптер сообщает об ожидании",
    "Message offered to a CLI session": "Сообщение предложено сессии CLI",
    "Session explicitly reported message viewed": "Сессия явно сообщила о просмотре сообщения",
    "Session explicitly reported message acceptance": "Сессия явно сообщила о приёме сообщения",
    "Unknown client report type": "Неизвестный тип клиентского отчёта",
    "{0} ({1}) · {2}\nStored {3} · seq {4}\nCLI session: {5} · channel: {6}": "{0} ({1}) · {2}\nСохранено {3} · seq {4}\nСессия CLI: {5} · канал: {6}",
    "Related message: {0}": "Связанное сообщение: {0}",
    "Attributed acceptance report, not a legacy receipt or proof of completion.": "Атрибутированный отчёт о приёме, не legacy-receipt и не доказательство выполнения.",
    "No CLI reports in this channel’s loaded window.": "В загруженном окне этого канала отчётов CLI нет.",
    "Reading activity for the selected channel…": "Чтение активности выбранного канала…",
    "Only #{0} ({1}). Authorship is determined by the sender’s personal key.": "Только #{0} ({1}). Автор определяется личным ключом отправителя.",
    "{0} reports in the feed. {1}Up to 200 most recently loaded reports are retained. {2}The cursor also includes messages and receipts; it is not a completed-task count.": "{0} отчётов в ленте. {1}Хранятся до 200 последних загруженных отчётов. {2}Курсор включает также сообщения и подтверждения; это не счётчик выполненных задач.",
    "The initial window covers the last 200 channel cursor steps, not the entire archive. ": "Начальное окно — последние 200 шагов курсора канала, не весь архив. ",
    "Reading the next page… ": "Читается продолжение… ",
    "The API returned an invalid CLI activity snapshot.": "API вернул некорректный снимок активности CLI.",
    "The API returned an incorrect CLI activity scope or attribution.": "API вернул неверную область или атрибуцию активности CLI.",
    "Archived project “{0}” ({1}). History is available only to the owner, read-only. Return to Administration to restore it.": "Архив проекта «{0}» ({1}). История доступна только владельцу, только для чтения. Для восстановления вернитесь в «Администрирование».",
    "Writing is unavailable for this channel, or permissions are still being checked.": "Для этого канала запись недоступна или права ещё проверяются.",
    "Read-only mode. Agents send messages using their own keys.": "Режим просмотра. Сообщения отправляют агенты со своими ключами.",
    "Saving…": "Сохранение…",
    "Retry the same request ↑": "Повторить тот же запрос ↑",
    "Send ↑": "Отправить ↑",
    "Publishing…": "Публикация…",
    "Retry the same request": "Повторить тот же запрос",
    "Publish to project": "Опубликовать в проект",
    "Acting as: {0} ({1}). Another sender cannot be selected.": "От имени: {0} ({1}). Нельзя выбрать другого отправителя.",
    "Project notes": "Заметки проекта",
    "No selected channel": "Нет выбранного канала",
    "Published for the entire project “{0}”": "Опубликовано для всего проекта «{0}»",
    "Channel {0} · permitted messages and events only": "Канал {0} · только разрешённые сообщения и события",
    "Select an available channel or project notes.": "Выберите доступный канал или заметки проекта.",
    "Checking project access…": "Проверка доступа к проекту…",
    "Loading channel…": "Загрузка канала…",
    "Loading project notes…": "Загрузка заметок проекта…",
    "The selected project is no longer available. Another available project’s overview was opened; check its name before continuing.": "Выбранный проект больше недоступен. Открыт обзор другого доступного проекта; проверьте название перед продолжением.",
    "The selected project is no longer available. Its data has been cleared; new permissions will appear automatically.": "Выбранный проект больше недоступен. Его данные очищены; новые права появятся автоматически.",
    "No available projects. New projects and granted access will appear automatically.": "Нет доступных проектов. Новые проекты и выданный доступ появятся автоматически.",
    "Access unconfirmed": "Доступ не подтверждён",
    "The server denied data access. See the reason above; an empty dataset has not been established.": "Сервер отказал в доступе к данным. Причина указана выше; пустота данных не подтверждена.",
    "Access to the selected data changed · checking the available workspace": "Доступ к выбранным данным изменился · проверяем доступное пространство",
    "Refresh failed · showing the last received data": "Не удалось обновить · показаны последние полученные данные",
    "Data not received yet · retrying through fallback polling": "Данные ещё не получены · повтор по резервному опросу",
    "The key is revoked or invalid. Data and the key have been cleared from this tab.": "Ключ отозван или недействителен. Данные и ключ удалены из вкладки.",
    "Access to the workspace stream was denied. Connect with a valid personal key.": "Доступ к потоку пространства отклонён. Подключитесь с действующим личным ключом.",
    "No more than 32 recipients are allowed.": "Допускается не более 32 получателей.",
    "Choose a recipient, or explicitly publish to the channel only.": "Выберите получателя или явно включите публикацию только в канал.",
    "Recipient access changed. Choose recipients again.": "Доступ получателей изменился. Выберите адресатов заново.",
    "The reply target is no longer available in this channel.": "Исходное сообщение для ответа больше недоступно в этом канале.",
    "No recipients selected.": "Получатели не выбраны.",
    "Selected recipients: {0}": "Выбранные получатели: {0}",
    "Channel publication · no native inbox recipients.": "Публикация в канал · без получателей во входящих native-коннектора.",
    "Publish to channel ↑": "Опубликовать в канал ↑",
    "Published to the channel only. This message will not enter any agent’s native inbox.": "Опубликовано только в канале. Это сообщение не попадёт во входящие native-коннектора ни одного агента.",
    "Stored for the selected recipients. This does not confirm viewing or acceptance.": "Сохранено для выбранных получателей. Это не подтверждает просмотр или приём.",
    "Waiting for server confirmation of storage…": "Ожидается подтверждение сохранения сервером…",
    "The server confirmed the previously stored message. No new copy was created.": "Сервер подтвердил ранее сохранённое сообщение. Новая копия не создана.",
    "Stored on the server. Delivery and acceptance are confirmed separately.": "Сохранено на сервере. Доставка и приём подтверждаются отдельно.",
    "Storage outcome is unknown. Retry the unchanged request: the same client_id prevents a second record but does not prove model execution.": "Результат сохранения неизвестен. Повторите неизменённый запрос: тот же client_id предотвращает создание второй записи, но не доказывает выполнение модели.",
    "Waiting for publication confirmation…": "Ожидается подтверждение публикации…",
    "Publication outcome is unknown. Retry without changing the fields: the same client_id will not create a second note.": "Результат публикации неизвестен. Повторите без изменения полей: тот же client_id не создаст вторую заметку.",
    "Ready for work": "Готова к работе",
    "Work reported": "Работа заявлена",
    "Artifacts submitted": "Артефакты представлены",
    "Awaiting review": "Ожидается ревью",
    "Approved by reviewer": "Одобрено ревьюером",
    "Reviewer requested changes": "Ревьюер запросил изменения",
    "Assignee reported completion": "Исполнитель заявил о завершении",
    "Uncertain · decision required": "Неопределённость · нужно решение",
    "Cancellation recorded": "Отмена записана",
    "Declare a new task run": "Объявить новый этап работы",
    "Submit the full artifact set": "Представить полный набор артефактов",
    "Request review of the set": "Запросить ревью набора",
    "Publish reviewer decision": "Опубликовать решение ревьюера",
    "Publish an external verification report": "Опубликовать внешний отчёт проверки",
    "Report completion": "Заявить о завершении",
    "Record uncertainty": "Зафиксировать неопределённость",
    "Record a recovery decision": "Записать решение о восстановлении",
    "Record cancellation": "Записать отмену",
    "Baseline": "Исходная база",
    "Implementation": "Реализация",
    "Test": "Тест",
    "Evidence / report": "Свидетельство / отчёт",
    "Bundle": "Комплект",
    "Project “{0}” ({1}){2}. Only data permitted for this account.": "Проект «{0}» ({1}){2}. Только данные, разрешённые этой учётной записи.",
    " · archived, read-only": " · архив, только чтение",
    "Sessions: read-only. No process controls.": "Сессии: только чтение. Никакого управления процессами.",
    "Publishing as {0}. The server independently checks permissions and versions.": "Публикация от имени {0}. Права и версии независимо проверяет сервер.",
    "Read-only, or permissions are not confirmed yet. The owner does not act on behalf of agents.": "Только чтение или права ещё не подтверждены. Владелец пространства не действует от имени агента.",
    "Assignee: {0} ({1})\nReviewer: {2} ({3})\nID {4} · version {5}": "Исполнитель: {0} ({1})\nРевьюер: {2} ({3})\nID {4} · версия {5}",
    "Open task": "Открыть задачу",
    "No tasks in this project.": "В этом проекте нет задач.",
    "Reading tasks…": "Чтение задач…",
    "Showing the latest 1,000 tasks.": "Показаны последние 1000 задач.",
    "Select a task to view its roles, artifact set, and timeline.": "Выберите задачу для просмотра ролей, набора артефактов и хронологии.",
    "ID {0} · version {1}\nAssignee {2} · independent reviewer {3}\nCurrent run: {4}\nUpdated: {5}": "ID {0} · версия {1}\nИсполнитель {2} · отдельный ревьюер {3}\nТекущий этап: {4}\nОбновлено: {5}",
    "not started": "не начат",
    "Scope of work": "Область работы",
    "Acceptance criteria": "Критерии приёмки",
    "External verification report: {0}. The server did not run tests.\nReview request: {1}": "Внешний отчёт проверки: {0}. Сервер тесты не запускал.\nЗапрос ревью: {1}",
    "none": "нет",
    "Report author {0} · {1}\nVersion {2} · run {3}\nEvent {4}": "Автор отчёта {0} · {1}\nВерсия {2} · run {3}\nСобытие {4}",
    "Assignee’s completion claim, not server-verified success.": "Заявление исполнителя о завершении, не проверенный сервером успех.",
    "Report from the assigned independent reviewer: {0}. Not server verification.": "Отчёт назначенного отдельного ревьюера: {0}. Не серверная проверка.",
    "approved": "одобрено",
    "changes required": "нужны изменения",
    "Related review request: {0}": "Связанный запрос ревью: {0}",
    "External verification report: {0}. Reported by the {1}, not the server.": "Внешний отчёт проверки: {0}. Источник — {1}, а не сервер.",
    "independent reviewer": "отдельный ревьюер",
    "assignee": "исполнитель",
    "Reported command: {0}\nReported exit_code: {1}": "Сообщённая команда: {0}\nСообщённый exit_code: {1}",
    "not specified": "не указан",
    "Decision: {0}. External processes are not started or stopped.": "Решение: {0}. Внешние процессы не запускаются и не останавливаются.",
    "No events have been published yet. Creating a task does not start work by itself.": "События пока не опубликованы. Создание задачи само по себе не запускает работу.",
    "Showing the latest 200 events. Earlier events remain on the server.": "Показаны последние 200 событий. Более ранние сохранены на сервере.",
    "History is not fully loaded. Continue paging; fresh events are shown separately from the history gap.": "История загружена не полностью. Продолжите постраничное чтение; свежие события показаны отдельно от пробела истории.",
    "Next history events": "Следующие события истории",
    "Load history from the beginning": "Загрузить историю с начала",
    "{0}{1} Recording an event does not execute commands.": "{0}{1} Запись события не запускает команды.",
    "Draft is bound to version {0}": "Черновик привязан к версии {0}",
    "Current version {0}": "Текущая версия {0}",
    "; the server already has a newer version. Review the data and explicitly rebase the draft.": "; сервер уже имеет новую версию. Пересмотрите данные и явно обновите привязку.",
    ". Submission requires a button click; no automatic retry.": ". Отправка только по кнопке, без автоматического повтора.",
    "Editing version {0}.{1}": "Редактируется версия {0}.{1}",
    " Version {0} has already been published: saving the old draft will be rejected (409), without overwriting. Close the draft and select the current version.": " Уже опубликована версия {0}: сохранение старого черновика будет отклонено (409), без перезаписи. Закройте черновик и выберите актуальную версию.",
    " Saving adds a new version; the previous one stays in history.": " Сохранение добавит новую версию; прежняя останется в истории.",
    "New public entry for project readers. Do not include secrets or hidden context.": "Новая публичная запись для читателей проекта. Не добавляйте секреты или скрытый контекст.",
    "Version {0} · {1}\nVersion author {2} · ID {3}": "Версия {0} · {1}\nАвтор версии {2} · ID {3}",
    "Select context and history": "Выбрать контекст и историю",
    "No published project memory yet.": "Опубликованной памяти проекта пока нет.",
    "Reading memory…": "Чтение памяти…",
    "Showing the latest 1,000 entries.": "Показаны последние 1000 записей.",
    "Current version {0} · ID {1}\nVersion author {2} · {3}": "Текущая версия {0} · ID {1}\nАвтор версии {2} · {3}",
    "Select a published memory entry.": "Выберите опубликованную запись памяти.",
    "Version {0} · {1}": "Версия {0} · {1}",
    "Author {0} · {1}": "Автор {0} · {1}",
    "Showing the latest 1,000 versions. Earlier versions have not been deleted.": "Показаны последние 1000 версий. Более ранние не удалены.",
    "The version changed or is unavailable. Select the current entry again; the reference is not updated automatically.": "Версия изменилась или недоступна. Выберите актуальную запись заново; ссылка не обновляется автоматически.",
    "The version matches the latest received snapshot.": "Версия совпадает с последним полученным снимком.",
    "ID {0} · selected version {1}\nVersion author {2} · {3}": "ID {0} · выбрана версия {1}\nАвтор версии {2} · {3}",
    "Remove from selected context": "Убрать из выбранного контекста",
    "Nothing selected.": "Ничего не выбрано.",
    "Selected context is stale: copying is blocked until you explicitly select it again.": "Выбранный контекст устарел: копирование заблокировано до явного повторного выбора.",
    "{0} / 4 entries · {1} / 16,384 UTF-8 bytes. Selection does not mean publication or execution.": "{0} / 4 записи · {1} / 16 384 байт UTF-8. Выбор не означает публикацию или запуск.",
    "Selection exceeds 16 KiB of UTF-8. Remove some entries; oversized context is not copied automatically.": "Выбор превышает 16 КиБ UTF-8. Уберите часть записей; большой контекст не копируется автоматически.",
    "Close the current unpublished memory draft and select another entry?": "Закрыть текущий черновик памяти без публикации и выбрать другую запись?",
    "Replace the open unpublished draft?": "Заменить открытый неопубликованный черновик?",
    "New version of entry {0}": "Новая версия записи {0}",
    "New memory entry": "Новая запись памяти",
    "Fresh session lease": "Свежая аренда сессии",
    "Lease is stale or access was lost": "Аренда устарела или доступ утрачен",
    "Session closed": "Сессия закрыта",
    "No public self-report.": "Публичного самоотчёта нет.",
    "Participant {0}\nSession {1}\nChannel {2} · run {3}\nRuntime {4} · model {5}\nRenewed {6}\nExpires {7} · deadline {8}{9}": "Участник {0}\nСессия {1}\nКанал {2} · run {3}\nRuntime {4} · модель {5}\nПродлено {6}\nИстекает {7} · крайний срок {8}{9}",
    "not reported": "не сообщена",
    "\nClosed {0}": "\nЗакрыто {0}",
    "Freshness unknown": "Свежесть неизвестна",
    "The API returned no sessions in channels you can access.": "API не вернул сессий доступных вам каналов.",
    "Loading sessions…": "Чтение сессий…",
    "Showing up to 200 sessions; this is not the full archive.": "Показаны до 200 сессий; это не полный архив.",
    "ID {0}\nBase revision {1}\nSHA-256 {2}\n{3} bytes · author {4}\nStored {5}": "ID {0}\nБазовая ревизия {1}\nSHA-256 {2}\n{3} байт · автор {4}\nСохранено {5}",
    "Download bytes after SHA-256 verification": "Скачать байты после проверки SHA-256",
    "No artifacts in this project.": "В этом проекте нет артефактов.",
    "Loading artifacts…": "Чтение артефактов…",
    "Check “{0}”: limit {1} UTF-8 bytes, with no null characters.": "Проверьте поле «{0}»: лимит {1} байт UTF-8, без нулевых символов.",
    "Waiting for the server to confirm storage…": "Ожидается подтверждение записи сервером…",
    "The server confirmed the previously stored record; no new copy was created.": "Сервер подтвердил ранее сохранённую запись; новой копии нет.",
    "Stored by the server. This confirms storage, not task execution or correctness.": "Сохранено сервером. Это подтверждение записи, не выполнения или правильности задачи.",
    "Change rejected due to a conflict. Your draft is preserved; review the current version. No automatic retry.": "Изменение отклонено из-за конфликта. Черновик сохранён; пересмотрите актуальную версию. Автоматического повтора нет.",
    "Storage was not confirmed. Check permissions and fields.": "Запись не подтверждена. Проверьте права и поля.",
    "Outcome unknown. No automatic retry. Retrying an unchanged request uses the same client_id.": "Результат неизвестен. Автоматического повтора нет. Повтор неизменённого запроса использует тот же client_id.",
    "The assignee and reviewer must be different agents.": "Исполнитель и ревьюер должны быть разными агентами.",
    "Provide 1 to 32 paths and 1 to 32 acceptance criteria.": "Укажите от 1 до 32 путей и критериев приёмки.",
    "Provide the complete set: 1 to 32 unique artifact IDs.": "Укажите полный набор: от 1 до 32 уникальных ID артефактов.",
    "The artifact must belong to the selected project.": "Артефакт должен принадлежать выбранному проекту.",
    "A verification report requires an evidence-role artifact from the current complete set.": "Отчёт проверки требует артефакт роли evidence из текущего полного набора.",
    "The exit code must be an integer.": "Код выхода должен быть целым числом.",
    "Select a file from 1 byte to 2 MiB.": "Выберите файл от 1 байта до 2 МиБ.",
    "Artifact integrity was not confirmed. Download cancelled.": "Целостность артефакта не подтверждена. Скачивание отменено.",
    "Bytes and SHA-256 verified. The file was passed to the browser as .bin; its contents were not executed.": "Байты и SHA-256 сверены. Файл передан браузеру как .bin; содержимое не выполнялось.",
    "The ID must exactly match the project ID, including case, with no extra spaces.": "ID должен в точности совпадать с ID проекта, включая регистр, без лишних пробелов.",
    "Close (request already sent)": "Закрыть (запрос уже отправлен)",
    "Cancel": "Отмена",
    "read and write": "чтение и запись",
    "read": "чтение",
    "no access": "нет доступа",
    "Select a channel": "Выберите канал",
    "Current access: project — {0}{1}. Account: {2} ({3}).": "Сейчас: проект — {0}{1}. Учётная запись: {2} ({3}).",
    "; channel — {0}": "; канал — {0}",
    "Select an account and parent project. Owner accounts cannot be modified through the web interface.": "Выберите учётную запись и родительский проект. Учётные записи владельцев нельзя изменять через веб.",
    "Before granting channel access, switch to “Project access” and explicitly save the parent permission.": "Перед выдачей канала переключитесь на «Доступ к проекту» и явно сохраните родительское право.",
    "Before granting channel write access, explicitly grant write access to its parent project. Viewers cannot receive write access.": "Для записи в канал сначала явно выдайте запись в родительский проект. Viewer не получает запись.",
    "The change takes effect only after confirmation. The server rechecks permissions and records an audit entry.": "Изменение применяется только после подтверждения. Сервер повторно проверяет права и сохраняет аудит.",
    "{0} active · {1} archived": "{0} активных · {1} архивных",
    "Archived": "В архиве",
    "Active": "Активный",
    "ID: {0} · state version: {1}": "ID: {0} · версия состояния: {1}",
    "not received": "не получена",
    "Archived: {0}. History is preserved; ordinary access is closed.": "Архивирован: {0}. История сохранена, обычный доступ закрыт.",
    "Participant access is determined by project and channel permissions. Archive the project before deletion.": "Доступ участников определяется правами проекта и каналов. Для удаления сначала нужен архив.",
    "Read archive": "Читать архив",
    "Open history": "Открыть историю",
    "Restore…": "Восстановить…",
    "Archive…": "Архивировать…",
    "Permanently delete…": "Удалить безвозвратно…",
    "No projects yet. Create the first project below.": "Проектов пока нет. Создайте первый проект ниже.",
    "Archive project “{0}” ({1})? History and permissions will be preserved. Agents and viewers will lose access, and writes will be blocked. The owner can read the archive. External work already dispatched and the agent’s global heartbeat will not be stopped.": "Архивировать проект «{0}» ({1})? История и права сохранятся. Агенты и наблюдатели потеряют доступ, запись будет закрыта. Владелец сможет читать архив. Уже отправленная внешняя работа и общий heartbeat агента не останавливаются.",
    "Restore project “{0}” ({1})? Previous participant permissions will take effect again: agents and viewers regain their prior access, including write access for agents previously granted it.": "Восстановить проект «{0}» ({1})? Прежние права участников снова начнут действовать: агенты и наблюдатели получат ранее разрешённый доступ, включая запись для агентов с такими правами.",
    "Project {0} archived. History and permissions are preserved; ordinary access is closed.": "Проект {0} архивирован. История и права сохранены; обычный доступ закрыт.",
    "Project {0} restored. Previous participant permissions apply again.": "Проект {0} восстановлен. Прежние права участников снова действуют.",
    "Project: {0} ({1}).": "Проект: {0} ({1}).",
    "Loading the current deletion inventory. Deletion is unavailable until then…": "Чтение свежего состава удаляемых данных. Пока удаление недоступно…",
    "Project access grants": "Права на проект",
    "Channel access grants": "Права на каналы",
    "Task run records": "Этапы задач",
    "Task events": "События задач",
    "Memory entries": "Записи памяти",
    "Artifact bytes": "Байты артефактов",
    "CLI activity reports": "Отчёты активности CLI",
    "The project is no longer archived. Deletion is unavailable. Close this dialog and refresh the project list.": "Проект больше не в архиве. Удаление недоступно. Закройте диалог и обновите список проектов.",
    "Project: {0} · exact ID: {1} · state version: {2}.": "Проект: {0} · точный ID: {1} · версия состояния: {2}.",
    "Inventory received from the server. Enter the exact ID above to send a single deletion request. The server will reject it if the version changes.": "Состав получен с сервера. Для однократного запроса удаления введите точный ID выше. При изменении версии сервер отклонит запрос.",
    "Inventory was not confirmed. Deletion is unavailable. {0} Close this dialog before requesting a new inventory.": "Состав не подтверждён. Удаление недоступно. {0} Закройте диалог перед новым просмотром состава.",
    "Sending a single deletion request. Closing this dialog will not cancel a request already sent. No automatic retry.": "Однократный запрос удаления отправляется. Закрытие диалога не отменит уже отправленный запрос. Автоматического повтора нет.",
    "Project {0} and its contents were deleted from the Agent Mesh server. Accounts and keys remain. Backups and copies held by agents were not deleted; project and channel IDs cannot be reused.": "Проект {0} и его содержимое удалены с сервера Agent Mesh. Учётные записи и ключи сохранены. Резервные копии и копии у агентов не удалялись; повторное использование ID проекта и каналов запрещено.",
    "{0} This deletion inventory is no longer usable. Close this dialog and obtain a new inventory before confirming.": "{0} Этот просмотр состава больше нельзя использовать. Закройте диалог и получите новый состав перед подтверждением.",
    "{0} accounts": "{0} учётных записей",
    "Key active": "Ключ активен",
    "Key inactive": "Ключ неактивен",
    "Fresh heartbeat": "Свежий heartbeat",
    "Stale heartbeat": "Heartbeat устарел",
    "Heartbeat unknown": "Heartbeat неизвестен",
    "Not an agent · heartbeat is not used": "Не является агентом · heartbeat не используется",
    "Owner. This account and its key can only be managed through the local CLI.": "Владелец. Управление этой учётной записью и её ключом — только через локальный CLI.",
    "Rotate key…": "Заменить ключ…",
    "Issue key…": "Выпустить ключ…",
    "Revoke key…": "Отозвать ключ…",
    "No accounts received.": "Учётные записи не получены.",
    "Select an active project": "Выберите активный проект",
    "Select an account": "Выберите учётную запись",
    "{0} · actor: {1}\n{2}: {3} · record {4}": "{0} · actor: {1}\n{2}: {3} · запись {4}",
    "local CLI": "локальный CLI",
    "No administrative actions in this snapshot.": "В этом снимке административных действий нет.",
    "Uncertain delivery": "Неопределённая доставка",
    "Awaiting acceptance": "Ожидается подтверждение приёма",
    "Message: {0}\nChannel: {1}\nAuthor: {2} → Recipient: {3}": "Сообщение: {0}\nКанал: {1}\nАвтор: {2} → Получатель: {3}",
    "Stored: {0}\nDelivered: {1}\nAccepted: {2}\nUncertain: {3}": "Сохранено: {0}\nДоставлено: {1}\nПринято: {2}\nНеопределённо: {3}",
    "No pending or uncertain deliveries in this snapshot.": "Ожидающих или неопределённых доставок в снимке нет.",
    "Loading the administrative snapshot…": "Чтение административного снимка…",
    "Maximum {0} UTF-8 bytes.": "Допускается не более {0} байт UTF-8.",
    "Waiting for server confirmation. The request is not retried automatically…": "Ожидается подтверждение сервера. Запрос не повторяется автоматически…",
    "API 409: the ID is occupied (including after deletion), the project version changed, or its state does not permit this action. Refresh the snapshot and check the project and permissions.": "API 409: ID занят (в том числе после удаления), версия проекта изменилась либо его состояние не допускает действие. Обновите снимок и проверьте проект и права.",
    "Deletion outcome unknown: server confirmation was not received. The request will not be retried. Close this dialog, refresh the project list and check the audit log. A new deletion requires a fresh inventory and entering the ID again.": "Результат удаления неизвестен: подтверждение сервера не получено. Запрос не будет повторён. Закройте диалог, обновите список проектов и проверьте аудит. Новое удаление возможно только после нового просмотра состава и ввода ID.",
    "Change outcome unknown: the server response was not received. No automatic retry. Refresh the snapshot and check the audit log before another explicit action. If the response containing a key was lost, that key cannot be retrieved again; another rotation requires separate confirmation.": "Результат изменения неизвестен: ответ сервера не получен. Автоматического повтора нет. Обновите снимок и проверьте аудит перед новым явным действием. Если ответ с ключом потерян, получить его повторно нельзя; новая замена ключа требует отдельного подтверждения.",
    "The change was not confirmed by this tab.": "Изменение не подтверждено этой вкладкой.",
    "Issue a new key for “{0}” ({1})? The old key will stop working immediately. The new key will be shown only once. History and the ID will be preserved.": "Выпустить новый ключ для «{0}» ({1})? Старый ключ сразу перестанет работать. Новый будет показан только один раз. История и ID сохранятся.",
    "Revoke the key for “{0}” ({1})? Agent Mesh access and existing SSE connections will end. The external CLI will not be stopped, and work already dispatched will not be cancelled.": "Отозвать ключ «{0}» ({1})? Доступ к Agent Mesh и существующие SSE-подключения будут прекращены. Внешний CLI не будет остановлен, уже отправленная работа не отменяется.",
    "Key for {0} rotated. The new secret is shown once.": "Ключ {0} заменён. Новый секрет показан один раз.",
    "Key for {0} revoked. Account history and permissions are preserved.": "Ключ {0} отозван. История и права учётной записи сохранены.",
    "Account: {0} ({1}).": "Учётная запись: {0} ({1}).",
    "Account {0} created without a key or permissions. Grant project access, then channel access; issue a key separately.": "Учётная запись {0} создана без ключа и прав. Выдайте проект, затем канал; выпустите ключ отдельно.",
    "Project {0} created. Participant access was not granted automatically.": "Проект {0} создан. Доступ участников не выдавался автоматически.",
    "Channel {0} created in project {1}. Channel access must be granted separately.": "Канал {0} создан в проекте {1}. Права на канал выдаются отдельно.",
    " All this account’s permissions for the project’s channels will also be removed.": " Все права этой учётной записи на каналы проекта также будут сняты.",
    "Change access for {0}: {1} {2} → {3}?{4}": "Изменить доступ {0}: {1} {2} → {3}?{4}",
    "project": "проект",
    "channel": "канал",
    "Access for {0} to {1}: {2}. Change confirmed by the server.": "Доступ {0} к {1}: {2}. Изменение подтверждено сервером.",
    "Key copied to the system clipboard. Keep it secret.": "Ключ скопирован в системный буфер обмена. Храните его как секрет.",
    "Automatic copying is unavailable. Copy the selected key manually.": "Автоматическое копирование недоступно. Скопируйте выделенный ключ вручную.",
    "Checking key…": "Проверка ключа…",
    "The API did not return a supported account.": "API не вернул поддерживаемую учётную запись.",
    "Owner · {0}": "Владелец · {0}",
    "Agent · {0}": "Агент · {0}",
    "Read-only · {0}": "Только просмотр · {0}",
    "Owner · reads all published context": "Владелец · чтение всего опубликованного контекста",
    "Author: {0} · permissions checked by the server": "Автор: {0} · права проверяет сервер",
    "Viewer · read-only": "Viewer · только чтение",
    "Hide": "Скрыть",
    "Rebase the draft on the current task version? The artifact set will be replaced with the current set; the summary will be preserved.": "Привязать черновик к актуальной версии задачи? Набор артефактов будет заменён актуальным; резюме сохранится.",
    "References copied. Memory contents and your personal key were not copied; no run was started.": "Ссылки скопированы. Содержимое памяти и личный ключ не копировались; запуск не выполнялся.",
    "Clipboard unavailable. You can manually copy the displayed references after checking their versions.": "Буфер обмена недоступен. Можно вручную скопировать показанные ссылки, предварительно сверив версии.",
    "Publish to the whole project “{0}” ({1}), as {2} ({3}).": "Опубликовать для всего проекта «{0}» ({1}), от имени {2} ({3}).",
    "Service: {0}. Your key is sent only to this server in the Authorization header.{1}": "Сервис: {0}. Ключ передаётся только этому серверу в заголовке Authorization.{1}",
    " HTTP is allowed only for a local loopback test.": " HTTP разрешён только для локального loopback-теста.",
    " HTTPS connection.": " Соединение HTTPS.",
    "Sign-in blocked: network connections require HTTPS. Do not enter your key on an HTTP page. Only localhost / 127.0.0.1 / ::1 are allowed for local testing.": "Вход заблокирован: для подключения по сети требуется HTTPS. Не вводите ключ на HTTP-странице. Исключение — только localhost / 127.0.0.1 / ::1 для локального теста."
  }; // I18N_CATALOG
  class LocalizedText {
    constructor(render) { this.render = render; }
    toString() { return this.render(); }
    [Symbol.toPrimitive]() { return this.toString(); }
    trim() { return new LocalizedText(() => String(this).trim()); }
    slice(...args) { return new LocalizedText(() => String(this).slice(...args)); }
    toLocaleUpperCase() { return new LocalizedText(() => String(this).toLocaleUpperCase(localeName())); }
  }
  const captureText = value => typeof value === "function" ? value() : value;
  const resolveText = value => String(value);
  // Capture scoped values once, while rendering. Switching languages must never
  // reread cleared authentication/project state or change the displayed snapshot.
  const tr = (message, ...inputs) => {
    const values = inputs.map(captureText);
    return new LocalizedText(() => {
      const template = language === "ru" && Object.hasOwn(RU_MESSAGES, message) ? RU_MESSAGES[message] : message;
      return template.replace(/\{(\d+)\}/g, (_, index) => resolveText(values[Number(index)] ?? ""));
    });
  };
  const formatText = (parts, ...inputs) => {
    const values = inputs.map(captureText);
    return new LocalizedText(() => parts.map((part, index) => part + (index < values.length ? resolveText(values[index]) : "")).join(""));
  };
  const joinText = (values, separator) => new LocalizedText(() => values.map(resolveText).join(String(separator)));
  const numberText = value => new LocalizedText(() => value.toLocaleString(localeName()));
  const textBindings = new Map(), attributeBindings = new Map(), validityBindings = new Map();
  let bindingCleanupQueued = false;
  function queueBindingCleanup() {
    if (bindingCleanupQueued) return;
    bindingCleanupQueued = true;
    queueMicrotask(() => {
      bindingCleanupQueued = false;
      for (const bindings of [textBindings, attributeBindings, validityBindings]) {
        for (const element of bindings.keys()) if (!element.isConnected) bindings.delete(element);
      }
    });
  }
  function ownedText(value) {
    value = captureText(value);
    const text = document.createTextNode(resolveText(value));
    textBindings.set(text, value); queueBindingCleanup(); return text;
  }
  function setText(element, value) {
    element.replaceChildren(ownedText(value)); return element.textContent;
  }
  function appendOwned(element, ...values) {
    for (const value of values) {
      const resolved = typeof value === "function" ? value() : value;
      element.append(resolved instanceof Node ? resolved : ownedText(resolved));
    }
  }
  function setOwnedAttribute(element, name, value) {
    value = captureText(value);
    element.setAttribute(name, resolveText(value));
    if (!["aria-label", "placeholder", "title", "label"].includes(name)) return;
    const bindings = attributeBindings.get(element) || new Map(); bindings.set(name, value);
    attributeBindings.set(element, bindings); queueBindingCleanup();
  }
  function setOwnedValidity(element, value) {
    value = captureText(value);
    element.setCustomValidity(resolveText(value)); validityBindings.set(element, value); queueBindingCleanup();
  }
  const staticTranslations = [];
  function captureStaticTranslations() {
    for (const element of document.querySelectorAll("[data-i18n-ru]")) {
      if (!element.children.length) staticTranslations.push({element, english: element.textContent, russian: element.dataset.i18nRu});
    }
    for (const name of ["aria-label", "placeholder", "title", "label"]) {
      const annotation = `data-i18n-ru-${name}`;
      for (const element of document.querySelectorAll(`[${annotation}]`)) staticTranslations.push({element, name, english: element.getAttribute(name) || "", russian: element.getAttribute(annotation)});
    }
  }
  function applyLanguage(next, updateURL = false) {
    if (!["en", "ru"].includes(next)) return;
    language = next; document.documentElement.lang = next;
    for (const entry of staticTranslations) {
      const value = next === "ru" ? entry.russian : entry.english;
      if (entry.name) entry.element.setAttribute(entry.name, value); else entry.element.textContent = value;
    }
    for (const [text, value] of textBindings) {
      if (!text.isConnected) { textBindings.delete(text); continue; }
      const translated = resolveText(value); if (text.data !== translated) text.data = translated;
    }
    for (const [element, bindings] of attributeBindings) {
      if (!element.isConnected) { attributeBindings.delete(element); continue; }
      for (const [name, value] of bindings) element.setAttribute(name, resolveText(value));
    }
    for (const [element, value] of validityBindings) {
      if (!element.isConnected) { validityBindings.delete(element); continue; }
      element.setCustomValidity(resolveText(value));
    }
    const selector = document.getElementById("language-select"); if (selector) selector.value = next;
    // Only this preference is written to the URL: never retain query credentials.
    if (updateURL) history.replaceState(null, "", `${location.pathname}?lang=${next}`);
  }

  // Keys, data, cursors and pending idempotency IDs live only in this closure.
  // No cookies, browser storage, query credentials, EventSource or third-party requests.
  const $ = (id) => document.getElementById(id);
  const state = {
    key: "", me: null, projects: [], channels: [], agents: [], notes: [], notesTruncated: false,
    project: null, channel: null, view: "chat", messages: new Map(), events: new Map(),
    nativeReceipts: new Map(), nativeReceiptIDs: new Set(), nativeReceiptsChannel: "", nativeReceiptsStatus: "pending", nativeReceiptsSeq: 0,
    nativeActivity: new Map(), nativeSeq: 0, nativeReady: false, nativeMore: false, nativeWindowAfter: 0,
    cursors: new Map(), messageSeq: 0, context: 0, authVersion: 0,
    requests: new Set(), stream: null, reconnectTimer: null, refreshTimer: null,
    pollTimer: null, streamWatchdog: null, retry: 0, refreshing: false,
    lastRefresh: 0, refreshAgain: false, streamConnected: false,
    workspaceRevision: "", lastSync: 0, syncError: false, channelSeen: new Map(), channelUpdates: new Set(),
    navigation: null, navigationSeq: 0, navigationRead: null, navigationReadTimer: null,
    pendingMessage: null, pendingNote: null, sending: false, publishing: false, replyRecipient: "",
    loginBusy: false, loading: false, dataReady: false, projectReady: false,
    admin: null, adminLoading: false, adminBusy: false, adminKey: "", adminKeyVersion: 0,
    onboarding: null, onboardingCommand: "", onboardingVersion: 0, onboardingDownload: "",
    onboardingGuidance: {guide: null, result: null}, onboardingGuideSeq: 0, onboardingGuideURLs: new Map(),
    adminDelete: null, adminDeleteEpoch: 0, adminDeleteLoading: false, adminDeleteSubmitting: false,
    adminReadSeq: 0, adminWriteVersion: 0, adminLoadBackground: false,
    coordination: null, coordinationEpoch: 0, coordinationBusy: false, downloads: new Set(),
    overview: null, adminSection: "accounts", accessRecheckUntil: 0,
    deliveryAlerts: null, deliveryDraft: null, deliveryDirty: false, deliveryConflict: false,
    deliverySeq: 0, deliveryWriteSeq: 0, deliveryLoading: false, deliverySaving: false, deliveryPolicyLoading: false,
    deliveryDraftSeq: 0, deliveryDenied: false,
    deliveryTimer: null, deliveryLastAttempt: 0, deliveryNotice: "", deliveryError: "", deliveryPolicyError: "",
    deliveryLinkSeq: 0, highlightMessage: "",
    projectNative: null, projectNativeEpoch: 0,
    projectMap: null, projectMapEpoch: 0,
    // Display preference lasts for this page session, across views and accounts.
    // It never changes data, transport cursors, credentials, or browser storage.
    showTechnicalEvents: false,
  };
  const EVENTS_PAGE = 25;
  const MESSAGES_PAGE = 100;
  const REFRESH_MIN_MS = 650;
  const POLL_MS = 8000;
  const REQUEST_TIMEOUT_MS = 15000;
  const PROJECT_NATIVE_LIMIT = 100;
  const PROJECT_NATIVE_MAX = 200;
  const PROJECT_NATIVE_FRESH_MS = 5 * 60 * 1000;
  const ROUTINE_NATIVE_TYPES = new Set(["session.started", "session.ended", "turn.started", "turn.completed", "tool.started", "tool.completed", "inbox.offered", "agent.waiting"]);
  const TECHNICAL_TOGGLES = ["project-native-technical", "native-technical", "activity-technical", "project-map-technical"];
  const nativeEventVisible = event => state.showTechnicalEvents || !ROUTINE_NATIVE_TYPES.has(event.event_type);
  const mapEntityVisible = (item, selectedType) => state.showTechnicalEvents || Boolean(selectedType) || (item.type !== "receipt" && !(item.type === "native" && ROUTINE_NATIVE_TYPES.has(item.meta?.type)));
  const channelMessageSeq = channel => number(Object.hasOwn(channel, "latest_message_seq") ? channel.latest_message_seq : channel.latest_seq);

  function renderTechnicalNotice(id, hidden, map = false) {
    $(id).dataset.hiddenCount = String(hidden);
    setText($(id), () => (map
      ? hidden ? tr("{0} technical entities hidden in this loaded sample. Counts above include them; select their type or show technical events to view them.", () => hidden) : tr("All matching entity types are shown in this loaded sample. Entities outside the sample are not shown.")
      : state.showTechnicalEvents ? tr("All event types are shown in this loaded window. Earlier events may be outside the window.") : tr("{0} technical events hidden in this loaded window. No records were deleted; earlier events may be outside the window.", () => hidden)));
  }
  const MAP_TYPES = {project: tr("Projects"), agent: tr("Participants"), channel: tr("Channels"), message: tr("Messages"), receipt: tr("Receipts"), task: tr("Tasks"), run: tr("Task runs"), "task-event": tr("Events / review"), artifact: tr("Artifacts"), memory: tr("Memory"), "memory-version": tr("Memory versions"), note: tr("Notes"), session: tr("Session leases"), native: tr("CLI reports")};
  const MAP_META = {project_id: tr("Project"), agent_id: tr("Participant"), kind: tr("Account type"), channel_id: tr("Channel"), author_id: tr("Author"), actor_id: tr("Report author"), reply_to: tr("Reply to message"), recipient_ids: tr("Recipients"), seq: tr("Channel sequence"), created_at: tr("Created"), updated_at: tr("Updated"), message_id: tr("Message"), session_id: tr("Session ID from this record"), delivered_at: tr("Delivery reported"), accepted_at: tr("Acceptance reported"), uncertain_at: tr("Uncertainty recorded"), type: tr("Event type"), runtime: "Runtime", run_id: tr("Run / execution ID from this record"), role: tr("Role"), expires_at: tr("Lease expiry"), closed_at: tr("Closed"), task_id: tr("Task"), owner_id: tr("Assignee"), reviewer_id: tr("Independent reviewer"), created_by: tr("Created by"), current_run_id: tr("Current task run"), state: tr("Published state"), version: tr("Version"), review_request_id: tr("Review request"), verification_status: tr("External verification report"), artifact_ids: tr("Explicit artifact references"), size_bytes: tr("Bytes"), memory_id: tr("Memory entry"), updated_by: tr("Version author"), source_message_id: tr("Source message"), verdict: tr("Reviewer decision"), evidence_artifact_id: tr("Verification artifact")};
  const COORDINATION_VIEWS = {tasks: tr("Tasks and review"), memory: tr("Project memory"), artifacts: tr("Artifacts"), sessions: tr("Sessions")};
  const isCoordination = (view = state.view) => Object.hasOwn(COORDINATION_VIEWS, view);
  const utf8 = new TextEncoder();
  const fieldLimits = [
    ["message-input", "message-size", 16384],
    ["note-title", "note-title-size", 200],
    ["note-body", "note-body-size", 16384],
  ];
  const safeTransport = location.protocol === "https:" ||
    (location.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(location.hostname));

  class ApiError extends Error {
    constructor(status, message) { super(String(message)); this.name = "ApiError"; this.status = status; this.localizedMessage = message; }
  }
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.append(ownedText(text));
    return element;
  };
  const pathId = (id) => encodeURIComponent(String(id));
  const list = (value) => Array.isArray(value) ? value : [];
  const number = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const current = (context) => Boolean(state.key) && context === state.context;
  const currentAuth = (version) => Boolean(state.key) && version === state.authVersion;
  const isWriter = () => state.me?.kind === "agent";
  const isOwner = () => state.me?.kind === "owner";
  const blockingAdminLoad = () => state.adminLoading && !state.adminLoadBackground;
  const canMessage = () => isWriter() && !state.project?.archived_at && Boolean(state.channel) && state.channel.can_write === true && state.dataReady;
  const canNote = () => isWriter() && Boolean(state.project) && !state.project.archived_at && state.channels.some((channel) => channel.can_write === true) && state.dataReady;
  const displayName = (id) => state.agents.find((agent) => agent.id === id)?.name || (state.me?.id === id ? state.me.name : id) || tr("Unknown participant");
  const dateText = (value) => {
    if (!value) return tr("no data");
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? tr("unknown time") : new LocalizedText(() => new Intl.DateTimeFormat(localeName(), {day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"}).format(date));
  };
  const errorText = (error) => {
    if (error.name === "AbortError") return tr("The request was cancelled or exceeded 15 seconds. Check the connection and try again.");
    if (error instanceof ApiError) return error.localizedMessage;
    return tr("The service is unavailable. Check your network and HTTPS certificate trust. Data has not been updated.");
  };
  function showError(error, target = "api-error") {
    setText($(target), () => (errorText(error)));
    $(target).hidden = false;
  }
  function clearError(target = "api-error") { setText($(target), () => ("")); $(target).hidden = true; }
  function validateSize(inputId, counterId, maxBytes) {
    const input = $(inputId);
    const value = input.value.trim();
    const bytes = utf8.encode(value).length;
    const message = value.includes("\0") ? tr("Null characters are not allowed.") :
      bytes > maxBytes ? tr("Text is too long: {0} UTF-8 bytes, limit {1}. Shorten the text.", () => (bytes), () => (maxBytes)) :
      input.value && !value ? tr("Enter text, not just whitespace.") : "";
    setOwnedValidity(input, () => (message));
    setText($(counterId), () => (tr("{0} / {1} UTF-8 bytes{2}", () => numberText(bytes), () => numberText(maxBytes), () => (message ? formatText([" · ", ""], message) : ""))));
    return !message;
  }
  function validateFields() { for (const limit of fieldLimits) validateSize(...limit); }
  function connection(text, kind = "loading") {
    setText($("connection-state"), () => (text));
    $("connection-state").dataset.state = kind;
  }

  function renderConnection() {
    if (!state.key) return;
    if (state.syncError) connection(tr("Data refresh unconfirmed · retry via stream or 8-second polling"), "reconnecting");
    else if (state.streamConnected) connection(tr("Connected · workspace-wide live updates"), "connected");
    else connection(state.retry ? tr("Stream interrupted · reconnecting · 8-second fallback polling") : tr("Connecting live stream · 8-second fallback polling"), "reconnecting");
    if (state.lastSync) setText($("updated-at"), () => (tr("Synced: {0}", () => (dateText(new Date(state.lastSync).toISOString())))));
  }

  // Preserve keyboard focus and scroll across read-only snapshot reconciliation.
  // Stable keys identify replaced controls; input forms themselves are never rebuilt.
  function replaceContent(id, ...children) {
    const container = $(id);
    if (container.childNodes.length === children.length && children.every((child, index) => child.isEqualNode(container.childNodes[index]))) return;
    const active = document.activeElement;
    const focusKey = container.contains(active) ? active?.dataset.focusKey : null;
    const top = container.scrollTop, left = container.scrollLeft;
    container.replaceChildren(...children);
    container.scrollTop = top; container.scrollLeft = left;
    if (focusKey) {
      const replacement = [...container.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === focusKey);
      if (replacement && !replacement.disabled) replacement.focus({preventScroll: true});
    }
  }

  async function api(path, options = {}) {
    if (!state.key || !safeTransport) throw new ApiError(401, tr("No connection with a personal access key."));
    const serializedBody = options.body ? JSON.stringify(options.body) : undefined;
    const bodyLimit = options.artifactUpload === true ? 3 * 1024 * 1024 : 65536;
    if (serializedBody && utf8.encode(serializedBody).length > bodyLimit) throw new ApiError(413, tr("The JSON-encoded request exceeds the size limit. Reduce its content."));
    const authVersion = state.authVersion;
    const controller = new AbortController();
    state.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(path, {
        method: options.method || "GET",
        headers: {Authorization: `Bearer ${state.key}`, Accept: "application/json", ...(options.body ? {"Content-Type": "application/json"} : {})},
        body: serializedBody,
        signal: controller.signal, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
      });
      if (authVersion !== state.authVersion) throw new DOMException("Stale authentication", "AbortError");
      if (response.status === 401) {
        lock(tr("The key is invalid or revoked. All data and the key have been cleared from this tab."));
        throw new ApiError(401, tr("Authentication has ended."));
      }
      if (!response.ok) {
        // Error bodies may contain sensitive diagnostics and are not rendered.
        // Release their stream explicitly; an unread 409 body otherwise outlives
        // the request controller and can linger in Chromium after logout.
        try { await response.body?.cancel(); } catch { /* Already closed/aborted. */ }
        if (authVersion !== state.authVersion) throw new DOMException("Stale authentication", "AbortError");
        if (response.status === 403) { clearAdminKey(); clearAdminDelete(); }
        // Fixed messages avoid accidentally echoing credential-bearing backend diagnostics.
        const descriptions = {
          400: tr("Invalid request. Check the fields and recipients."),
          403: tr("This account does not have permission to perform that action."),
          404: tr("The resource was not found or is unavailable to this account. This is an access error, not an empty list."),
          409: tr("Conflict: the server rejected the change. Retrying unchanged content is safe; different content requires a new request."),
          413: tr("Content exceeds the size limit."),
          429: tr("Too many requests. Try again later."),
        };
        throw new ApiError(response.status, formatText(["API ",": ",""], () => (response.status), () => (descriptions[response.status] || tr("The service returned an error. Data is unconfirmed."))));
      }
      // Artifact bytes are never interpreted as HTML, scripts, archives or commands.
      if (options.binary && number(response.headers.get("Content-Length")) > 2 * 1024 * 1024) throw new ApiError(413, tr("The artifact exceeds 2 MiB."));
      const payload = options.binary ? await response.arrayBuffer() : await response.json();
      if (authVersion !== state.authVersion) throw new DOMException("Stale authentication", "AbortError");
      return payload;
    } finally {
      clearTimeout(timeout);
      state.requests.delete(controller);
    }
  }

  function stopNetwork(endSession = false) {
    state.context += 1;
    invalidateDeliveryAlerts(endSession);
    clearNativeReceipts();
    for (const controller of state.requests) controller.abort();
    state.requests.clear();
    clearTimeout(state.refreshTimer); state.refreshTimer = null;
    if (endSession) {
      state.stream?.abort(); state.stream = null;
      for (const timer of [state.reconnectTimer, state.pollTimer, state.streamWatchdog]) clearTimeout(timer);
      state.reconnectTimer = state.pollTimer = state.streamWatchdog = null;
      state.streamConnected = false; state.retry = 0; state.workspaceRevision = "";
      state.lastSync = 0; state.syncError = false;
      state.channelSeen.clear(); state.channelUpdates.clear();
      state.navigation = null; state.navigationRead = null;
      state.navigationSeq += 1;
      clearTimeout(state.navigationReadTimer); state.navigationReadTimer = null;
      state.accessRecheckUntil = 0;
    }
    state.refreshing = false;
    state.refreshAgain = false;
    state.lastRefresh = 0;
    state.loading = false;
    state.sending = false;
    state.publishing = false;
    state.adminLoading = false;
    state.adminReadSeq += 1;
    state.coordinationBusy = false;
    state.coordinationEpoch += 1;
  }

  function clearDrafts() {
    $("composer-form").reset();
    state.replyRecipient = "";
    $("note-form").reset();
    setText($("send-status"), () => (""));
    setText($("note-status"), () => (""));
    $("search-input").value = "";
    state.pendingMessage = state.pendingNote = null;
    syncComposerAddressing();
    validateFields();
    if ($("note-dialog").open) $("note-dialog").close();
  }

  function clearData() {
    clearOverview();
    clearProjectNative();
    clearProjectMap();
    setText($("workspace-notice"), () => ("")); $("workspace-notice").hidden = true;
    clearAdminData();
    clearCoordination();
    clearNativeActivity();
    state.projects = []; state.channels = []; state.agents = []; state.notes = []; state.notesTruncated = false;
    $("notes-truncated").hidden = true;
    state.project = null; state.channel = null; state.me = null;
    state.messages.clear(); state.events.clear(); state.cursors.clear();
    state.messageSeq = 0; state.dataReady = false; state.projectReady = false; state.view = "chat";
    clearDrafts();
    for (const id of ["project-switcher", "channel-list", "agent-list", "message-list", "activity-list", "memory-list", "recipient-list"]) $(id).replaceChildren();
    $("reply-to").replaceChildren(node("option", "", () => (tr("New message"))));
    $("reply-to").firstChild.value = "";
    for (const id of ["channel-description", "channel-feed-name", "activity-scope", "activity-technical-notice", "notes-destination", "note-publish-target", "composer-identity", "updated-at"]) setText($(id), () => (""));
    $("activity-technical-notice").dataset.hiddenCount = "0";
    setText($("project-name"), () => ("Agent Mesh"));
    setText($("current-channel"), () => (tr("Select a project")));
    setText($("message-count"), () => ("0"));
    setText($("profile-name"), () => (tr("Not connected")));
    setText($("profile-role"), () => (tr("Personal access key required")));
    setText($("access-label"), () => (tr("Access is checked by the server")));
    $("history-notice").hidden = true;
    $("archived-project-notice").hidden = true; setText($("archived-project-notice"), () => (""));
    $("refresh-button").disabled = false;
    setText($("empty-panel"), () => (tr("Select an available project and channel.")));
    setText($("connection-state"), () => (tr("Not connected")));
    clearError();
    updatePermissions();
  }

  function lock(message = "") {
    state.key = ""; state.authVersion += 1;
    stopNetwork(true); clearData();
    document.body.classList.remove("authenticated"); setNavigationOpen(false);
    $("overview-panel").hidden = true; setText($("view-name"), () => (""));
    $("project-native-panel").hidden = true;
    $("project-map-panel").hidden = true;
    state.loginBusy = false;
    $("api-key").value = ""; $("api-key").type = "password";
    setText($("key-reveal"), () => (tr("Show")));
    $("key-reveal").setAttribute("aria-pressed", "false");
    $("navigation").hidden = true; $("connected-workspace").hidden = true;
    $("admin-navigation").hidden = true; $("admin-panel").hidden = true;
    $("ordinary-workbench").hidden = false;
    $("coordination-panel").hidden = true;
    $("logout-button").hidden = true; $("login-panel").hidden = false;
    $("login-button").disabled = !safeTransport; $("api-key").disabled = !safeTransport;
    setText($("login-button"), () => (tr("Connect")));
    if (message) { setText($("login-error"), () => (message)); $("login-error").hidden = false; }
    else clearError("login-error");
  }

  function avatar(id) {
    const result = node("span", "message-avatar", () => (displayName(id).slice(0, 1).toLocaleUpperCase(localeName())));
    result.setAttribute("aria-hidden", "true");
    return result;
  }

  // Overview is a bounded, authorized snapshot, not an inference about model execution.
  // It uses the existing workspace stream/poll and never scans other channels' messages.
  function clearOverview() {
    state.overview = null;
    for (const id of ["overview-agents", "overview-channels", "overview-attention", "overview-tasks"]) $(id).replaceChildren();
    for (const kind of ["agents", "tasks", "attention", "channels"]) setText($(`overview-metric-${kind}`), () => ("—"));
    setText($("overview-title"), () => (tr("Project overview"))); setText($("overview-note"), () => (""));
  }
  async function overviewSnapshot(context) {
    const projectId = state.project.id;
    const scopedRead = (path) => api(path).then(value => ({status: "fulfilled", value}), reason => {
      if ([401, 403, 404].includes(reason?.status)) throw reason;
      return {status: "rejected", reason};
    });
    const [taskResult, sessionResult] = await Promise.all([
      scopedRead(`/v1/projects/${pathId(projectId)}/tasks`), scopedRead(`/v1/projects/${pathId(projectId)}/sessions`),
    ]);
    if (!current(context) || state.project?.id !== projectId || state.view !== "overview") return;
    // Never retain data after explicit authorization denial. Temporary failures
    // are separate: an unavailable session summary must not hide readable tasks.
    const prior = state.overview?.projectId === projectId ? state.overview : null;
    const tasks = taskResult.status === "fulfilled" ? taskResult.value : null;
    const sessions = sessionResult.status === "fulfilled" ? sessionResult.value : null;
    state.overview = {
      projectId, tasks: tasks ? list(tasks.tasks).filter((task) => task.project_id === projectId) : prior?.tasks || [],
      sessions: sessions ? list(sessions.sessions).filter((session) => session.project_id === projectId) : prior?.sessions || [],
      tasksReady: Boolean(tasks || prior?.tasksReady), sessionsReady: Boolean(sessions || prior?.sessionsReady),
      taskError: !tasks, sessionError: !sessions,
      tasksTruncated: tasks ? tasks.truncated === true : prior?.tasksTruncated,
      sessionsTruncated: sessions ? sessions.truncated === true : prior?.sessionsTruncated,
      at: new Date().toISOString(),
    };
  }
  function overviewRow(title, meta, action, focusKey, tag) {
    const row = node("button", "overview-row"); row.type = "button"; row.dataset.focusKey = focusKey;
    appendOwned(row, () => (node("span", "overview-row-title", () => (title))), () => (node("span", "overview-row-meta", () => (meta))));
    if (tag) appendOwned(row, () => (tag));
    row.addEventListener("click", action); return row;
  }
  function renderOverview() {
    if (state.view !== "overview") return;
    if (!state.project) { clearOverview(); return; }
    const data = state.overview?.projectId === state.project.id ? state.overview : null;
    const tasks = data ? [...data.tasks].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))) : [];
    const attention = tasks.filter((task) => ["uncertain", "review_pending", "changes_requested"].includes(task.state));
    setText($("overview-title"), () => (formatText(["", "", ""], () => (state.project.name), () => (state.project.archived_at ? tr(" · archived") : ""))));
    setText($("overview-metric-agents"), () => (state.dataReady ? String(state.agents.length) : "—"));
    setText($("overview-metric-channels"), () => (state.projectReady ? String(state.channels.length) : "—"));
    setText($("overview-metric-tasks"), () => (data?.tasksReady ? `${tasks.length}${data.tasksTruncated ? "+" : ""}` : "—"));
    setText($("overview-metric-attention"), () => (data?.tasksReady ? `${attention.length}${data.tasksTruncated ? "+" : ""}` : "—"));
    setText($("overview-note"), () => (state.syncError ? (data ? tr("Refresh could not be confirmed. Showing the last received snapshot, not the current state.") : tr("No snapshot received yet: refresh is unconfirmed.")) : !data ? tr("Loading available tasks and sessions…") : data.taskError || data.sessionError ?
      tr("Refresh of {0} is unconfirmed. Previous values may be stale; “—” means no data has been received. Other available sections have been updated.", () => (joinText([data.taskError ? tr("tasks") : "", data.sessionError ? tr("sessions") : ""].filter(Boolean), tr(" and ")))) :
      formatText(["", "", ""], () => (formatText(["", "", ""], () => (tr("Snapshot {0} · {1}{2} fresh session leases, not an indication of model activity. ", () => (dateText(data.at)), () => (data.sessions.filter((session) => session.freshness === "fresh").length), () => (data.sessionsTruncated ? "+" : ""))), () => (data.tasksTruncated ? tr("Tasks: latest 1,000; overview is incomplete. ") : ""))), () => (tr("Only data available to you. View deliveries and CLI activity inside channels.")))));
    $("overview-note").dataset.stale = String(state.syncError || data?.taskError || data?.sessionError || false);
    const empty = (text) => node("p", "overview-empty", () => (text));
    const taskRow = (task) => overviewRow(task.title, formatText([""," → "," · ",""], () => (displayName(task.owner_id)), () => (displayName(task.reviewer_id)), () => (dateText(task.updated_at))),
      () => { if (state.project?.id === task.project_id && !state.coordinationBusy) { selectTaskData(coordinationData(), task.id); void selectCoordination("tasks"); } },
      `overview-task:${task.id}`, statusTag(task.state, TASK_STATES[task.state] || task.state));
    replaceContent("overview-attention", ...(attention.length ? attention.slice(0, 8).map(taskRow) : [empty(!data?.tasksReady ? tr("Task states have not been confirmed yet.") : state.syncError || data.taskError ? tr("The last snapshot contained no such tasks. Refresh is unconfirmed.") : tr("No loaded tasks are awaiting review, requesting changes, or marked uncertain."))]), ...(attention.length > 8 ? [empty(tr("Showing 8 of {0}. The rest are under All tasks.", () => (attention.length)))] : []));
    replaceContent("overview-tasks", ...(tasks.length ? tasks.slice(0, 6).map(taskRow) : [empty(data?.tasksReady ? tr("No tasks yet. They will appear after project participants publish them.") : tr("Task read is unconfirmed…"))]), ...(tasks.length > 6 ? [empty(tr("Showing 6 of {0}. Open Tasks and review for the full list.", () => (tasks.length)))] : []));
    replaceContent("overview-agents", ...(state.agents.length ? state.agents.map(agentCard) : [empty(state.dataReady ? tr("No visible participants yet.") : tr("Reading participants…"))]));
    replaceContent("overview-channels", ...(state.channels.length ? state.channels.map((channel) => overviewRow(`# ${channel.name}`,
      formatText(["","",""], () => (channel.can_write && isWriter() && !state.project.archived_at ? tr("Can send messages") : tr("Read-only view")), () => (state.channelUpdates.has(channel.id) ? tr(" · new events") : "")),
      () => { if (state.channels.some((item) => item.id === channel.id)) void selectChannel(channel); }, `overview-channel:${channel.id}`)) : [empty(state.projectReady ? tr("No available channels yet. The workspace owner grants access.") : tr("Checking channel access…"))]));
  }
  async function selectOverview() {
    if (!state.project || state.adminBusy || state.coordinationBusy || state.view === "overview") return;
    stopNetwork(); clearError(); setView("overview"); await refresh();
  }
  function setNavigationOpen(open) {
    document.body.classList.toggle("nav-open", open);
    $("sidebar-toggle").setAttribute("aria-expanded", String(open));
    setOwnedAttribute($("sidebar-toggle"), "aria-label", () => (open ? tr("Close navigation") : tr("Open navigation")));
    if (!open) scheduleChannelRead();
  }
  function setAdminSection(section) {
    if (!["onboarding", "accounts", "projects", "access", "diagnostics", "delivery-alerts"].includes(section)) return;
    state.adminSection = section;
    $("admin-panel").querySelector(".admin-heading").hidden = section === "onboarding";
    const groups = {
      onboarding: [$("admin-onboarding-panel")],
      "delivery-alerts": [$("admin-delivery-alerts-panel")],
      accounts: [$("admin-principal-list").closest("section"), $("admin-principal-form").closest("section")],
      projects: [$("admin-project-list").closest("section"), $("admin-project-form").closest("section"), $("admin-channel-form").closest("section")],
      access: [$("admin-access-form").closest("section")],
      diagnostics: [$("admin-panel").querySelector(".admin-diagnostic-grid")],
    };
    for (const [name, elements] of Object.entries(groups)) for (const element of elements) element.hidden = name !== section;
    $("admin-panel").querySelector(".admin-form-grid").hidden = !["accounts", "projects"].includes(section);
    for (const button of $("admin-section-nav").querySelectorAll("button")) {
      const active = button.dataset.adminSection === section;
      button.setAttribute("aria-pressed", String(active));
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
  }

  function renderNavigation() {
    const projectActivity = new Map(list(state.navigation?.projects).map(item => [item.id, item]));
    const channelActivity = new Map(list(state.navigation?.channels).map(item => [item.id, item]));
    replaceContent("project-switcher", ...state.projects.map((project) => {
      const button = activityNavigationButton(project.name, projectActivity.get(project.id), "project");
      button.type = "button"; button.disabled = state.adminBusy;
      button.dataset.focusKey = `project:${project.id}`;
      button.setAttribute("aria-pressed", String(state.view !== "admin" && state.project?.id === project.id));
      button.addEventListener("click", () => { if (state.project?.id !== project.id || state.view === "admin") void selectProject(project); });
      return button;
    }));
    replaceContent("channel-list", ...state.channels.map((channel) => {
      const activity = channelActivity.get(channel.id);
      const updated = activity ? number(activity.unread_messages) > 0 : state.channelUpdates.has(channel.id) && (state.channel?.id !== channel.id || isCoordination() || ["overview", "project-native", "project-map"].includes(state.view));
      const button = activityNavigationButton(`# ${channel.name}`, activity, "channel");
      button.type = "button";
      button.dataset.focusKey = `channel:${channel.id}`; button.dataset.updated = String(updated);
      button.disabled = state.adminBusy;
      button.setAttribute("aria-pressed", String(state.channel?.id === channel.id && ["chat", "activity", "native"].includes(state.view)));
      button.addEventListener("click", () => {
        if (state.channel?.id === channel.id && ["chat", "activity", "native"].includes(state.view)) { setView("chat"); return; }
        void selectChannel(channel);
      });
      return button;
    }));
    if (!state.channels.length) appendOwned($("channel-list"), () => (node("p", "empty-state", () => (state.loading ? tr("Checking access…") : state.dataReady ? tr("No available channels") : tr("Channel access has not been confirmed yet")))));
    $("nav-notes").disabled = !state.project || state.loading || state.adminBusy;
    $("nav-notes").setAttribute("aria-pressed", String(state.view === "notes"));
    $("nav-overview").disabled = !state.project || state.loading || state.adminBusy || state.coordinationBusy;
    $("nav-overview").setAttribute("aria-pressed", String(state.view === "overview"));
    $("nav-project-native").disabled = !state.project || state.loading || state.adminBusy || state.coordinationBusy;
    $("nav-project-native").setAttribute("aria-pressed", String(state.view === "project-native"));
    $("nav-project-map").disabled = !state.project || state.loading || state.adminBusy || state.coordinationBusy;
    $("nav-project-map").setAttribute("aria-pressed", String(state.view === "project-map"));
    for (const view of Object.keys(COORDINATION_VIEWS)) {
      $(`nav-${view}`).disabled = !state.project || state.loading || state.adminBusy || state.coordinationBusy;
      $(`nav-${view}`).setAttribute("aria-pressed", String(state.view === view));
    }
    $("admin-navigation").hidden = !isOwner();
    $("nav-admin").disabled = state.adminBusy;
    $("nav-connect-agent").disabled = state.adminBusy;
    $("nav-admin").setAttribute("aria-pressed", String(state.view === "admin"));
    setText($("project-name"), () => (state.view === "admin" ? tr("Administration") : state.project ? formatText(["","",""], () => (state.project.name), () => (state.project.archived_at ? tr(" · archived") : "")) : tr("No available projects")));
    setText($("view-name"), () => (({overview: tr("Overview"), "project-map": tr("Project map"), "project-native": tr("Project CLI feed"), chat: tr("Discussion"), activity: tr("Events"), native: tr("CLI activity"), notes: tr("Notes"), ...COORDINATION_VIEWS})[state.view] || ""));
    for (const button of $("navigation").querySelectorAll("button[aria-pressed]")) {
      if (button.getAttribute("aria-pressed") === "true") button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    const unreadChannels = list(state.navigation?.channels).filter(channel => number(channel.unread_messages) > 0);
    const total = unreadChannels.reduce((sum, channel) => sum + number(channel.unread_messages), 0);
    $("nav-unread").disabled = !total || state.adminBusy || state.loading;
    $("nav-unread").dataset.unread = String(total);
    $("nav-unread").dataset.stale = String(state.syncError);
    setText($("nav-unread-count"), () => state.navigation ? total ? tr("{0} unread", () => numberText(total)) : tr("All caught up") : tr("Checking messages…"));
    setText($("nav-unread-detail"), () => state.syncError ? tr("Refresh unconfirmed") : total ? tr("Across {0} channels · open next →", () => unreadChannels.length) : tr("New replies will appear here"));
    renderOverview();
  }

  function activityNavigationButton(name, activity, kind) {
    const button = node("button", `nav-button nav-activity nav-${kind}`);
    const unread = number(activity?.unread_messages);
    const lastMessage = activity?.last_message_at ? new Date(activity.last_message_at) : null;
    const recent = lastMessage && Number.isFinite(lastMessage.getTime()) && Date.now() - lastMessage.getTime() <= 5 * 60 * 1000;
    button.dataset.unread = String(unread); button.dataset.active = String(Boolean(recent));
    button.dataset.updated = String(unread > 0); button.dataset.stale = String(state.syncError);
    const top = node("span", "nav-activity-top"), title = node("span", "nav-activity-title", () => name);
    const badge = node("span", "nav-unread-badge", () => unread > 99 ? "99+" : String(unread)); badge.hidden = unread <= 0;
    setOwnedAttribute(badge, "aria-label", () => tr("{0} unread messages", () => numberText(unread)));
    appendOwned(top, () => title, () => badge);
    const meta = node("span", "nav-activity-meta"), dot = node("span", "nav-activity-dot"); dot.setAttribute("aria-hidden", "true");
    const when = node("span", "", () => !activity ? tr("Checking activity…") : !lastMessage ? tr("No messages yet") : recent ? tr("Recent discussion") : tr("Last message {0}", () => relativeMessageTime(lastMessage)));
    if (lastMessage) setOwnedAttribute(meta, "title", () => dateText(activity.last_message_at));
    appendOwned(meta, () => dot, () => when); appendOwned(button, () => top, () => meta);
    return button;
  }

  function relativeMessageTime(date) {
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    const [value, unit] = seconds < 60 ? [0, "minute"] : seconds < 3600 ? [-Math.floor(seconds / 60), "minute"] : seconds < 86400 ? [-Math.floor(seconds / 3600), "hour"] : [-Math.floor(seconds / 86400), "day"];
    return new Intl.RelativeTimeFormat(localeName(), {numeric: "auto"}).format(value, unit);
  }

  async function loadNavigation(context) {
    const requestSeq = ++state.navigationSeq;
    try {
      const data = await api("/v1/navigation");
      if (!current(context) || requestSeq !== state.navigationSeq) return;
      if (!Array.isArray(data.projects) || !Array.isArray(data.channels)) throw new Error("Invalid navigation snapshot");
      state.navigation = data;
    } catch (error) {
      if (!current(context) || requestSeq !== state.navigationSeq) return;
      state.navigation = null;
      if (error.status !== 404) throw error;
    }
  }

  function scheduleChannelRead() {
    if (state.navigationReadTimer) return;
    state.navigationReadTimer = setTimeout(() => { state.navigationReadTimer = null; void markVisibleChannelRead(); }, 150);
  }

  async function markVisibleChannelRead() {
    const scroller = $("message-list"), channelId = state.channel?.id, context = state.context;
    const activity = list(state.navigation?.channels).find(channel => channel.id === channelId);
    if (!activity || !state.dataReady || state.loading || state.view !== "chat" || document.hidden ||
        document.querySelector("dialog[open]") || document.body.classList.contains("nav-open") ||
        $("search-input").value.trim() || !scroller.clientHeight || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 45 || state.navigationRead) return;
    // A just-sent own message can appear ahead of REST replay. Do not skip any
    // intervening incoming messages that have not been fetched and rendered.
    const through = Math.min(state.messageSeq, Math.max(0, ...[...scroller.querySelectorAll("[data-message-seq]")].map(element => number(element.dataset.messageSeq))));
    if (!through || through <= number(activity.last_read_seq)) return;
    const request = {channelId, context}; state.navigationRead = request;
    state.navigationSeq += 1; // A pre-write GET must not restore an older cursor/count.
    try {
      await api(`/v1/channels/${pathId(channelId)}/read`, {method: "PUT", body: {through_seq: through}});
      if (!current(context)) return;
      await loadNavigation(context);
      if (current(context)) renderNavigation();
    } catch (error) {
      // A failed or cancelled acknowledgement never clears a badge optimistically.
      // The next authorized snapshot reconciles the monotonic cursor.
      if (current(context) && [403, 404].includes(error.status)) scheduleRefresh();
    } finally { if (state.navigationRead === request) state.navigationRead = null; }
  }

  async function openNextUnread() {
    if (state.adminBusy || state.loading) return;
    const target = list(state.navigation?.channels).filter(channel => number(channel.unread_messages) > 0)
      .sort((a, b) => String(b.last_message_at || "").localeCompare(String(a.last_message_at || "")))[0];
    const project = target && state.projects.find(item => item.id === target.project_id);
    if (!project) return;
    if (state.project?.id !== project.id || state.view === "admin") await selectProject(project);
    if (state.project?.id !== project.id) return;
    const channel = state.channels.find(item => item.id === target.id);
    if (channel) await selectChannel(channel);
  }

  function agentCard(agent) {
      const card = node("article", "agent-card");
      const heading = node("div", "agent-heading");
      appendOwned(heading, () => (avatar(agent.id)), () => (node("h3", "agent-name", () => (agent.name || agent.id))));
      const freshness = ["fresh", "stale", "unknown"].includes(agent.freshness) ? agent.freshness : "unknown";
      const labels = {fresh: tr("● Fresh adapter heartbeat"), stale: tr("◷ Heartbeat is stale"), unknown: tr("○ Heartbeat unknown")};
      const status = node("span", "agent-freshness", () => (agent.kind === "viewer" ? tr("Viewer · no heartbeat") : labels[freshness]));
      status.dataset.freshness = freshness;
      appendOwned(card, () => (heading), () => (status), () => (node("p", "agent-activity", () => (agent.activity ? tr("Self-report: {0}", () => (agent.activity)) : tr("No activity self-report")))), () => (node("p", "agent-foot", () => (tr("Last heartbeat: {0}\nID: {1}{2}", () => (dateText(agent.last_seen_at)), () => (agent.id), () => (agent.runtime ? ` · ${agent.runtime}` : ""))))));
      if (agent.session_id) appendOwned(card, () => (node("p", "agent-foot", () => (tr("Adapter session: {0}", () => (agent.session_id))))));
      return card;
  }
  function renderAgents() {
    replaceContent("agent-list", ...state.agents.map(agentCard));
    if (!state.agents.length) appendOwned($("agent-list"), () => (node("p", "empty-state", () => (state.loading ? tr("Loading participants…") : state.dataReady ? tr("The API returned no visible participants.") : tr("Participant data has not been received yet.")))));
  }

  function availableRecipients() {
    if (!state.channel) return [];
    const members = state.channel?.member_ids;
    return state.agents.filter((agent) => agent.kind === "agent" && agent.id !== state.me?.id &&
      (Array.isArray(members) ? members.includes(agent.id) : list(agent.channel_ids).includes(state.channel?.id)));
  }

  function recipientScope() {
    return JSON.stringify([state.authVersion, state.me?.id, state.project?.id, state.channel?.id]);
  }

  function selectedRecipients() {
    return [...$("recipient-list").querySelectorAll("input:checked")].map(input => input.value).sort();
  }

  function syncComposerAddressing() {
    const channelOnly = $("channel-only").checked;
    $("recipient-fieldset").disabled = !canMessage() || state.sending || channelOnly;
    for (const input of $("recipient-list").querySelectorAll("input")) input.disabled = !canMessage() || state.sending || channelOnly;
    $("channel-only-warning").hidden = !channelOnly;
    const recipients = selectedRecipients();
    setText($("recipient-summary"), () => channelOnly ? tr("Channel publication · no native inbox recipients.") : recipients.length ?
      tr("Selected recipients: {0}", recipients.map(id => `${displayName(id)} (${id})`).join(", ")) : tr("No recipients selected."));
  }

  function selectReply(messageId) {
    if (!canMessage() || state.sending) return;
    const message = state.messages.get(messageId);
    if (messageId && (!message || message.channel_id !== state.channel?.id)) return;
    $("reply-to").value = messageId;
    if (!$("channel-only").checked && $("recipient-list").dataset.scope === recipientScope()) {
      const selected = selectedRecipients();
      if (!selected.length || selected.length === 1 && selected[0] === state.replyRecipient) {
        const author = availableRecipients().find(agent => agent.id === message?.author_id)?.id || "";
        for (const input of $("recipient-list").querySelectorAll("input")) input.checked = input.value === author;
        state.replyRecipient = author;
      }
    }
    syncComposerAddressing();
  }

  function renderRecipients() {
    const sameScope = $("recipient-list").dataset.scope === recipientScope();
    const selected = new Set(sameScope ? selectedRecipients() : []);
    const recipients = availableRecipients();
    if ([...selected].some(id => !recipients.some(agent => agent.id === id))) {
      selected.clear(); state.replyRecipient = "";
      setText($("send-status"), () => tr("Recipient access changed. Choose recipients again."));
    }
    if (!sameScope) state.replyRecipient = "";
    $("recipient-list").dataset.scope = recipientScope();
    replaceContent("recipient-list", ...recipients.map((agent) => {
      const label = node("label", "recipient-option");
      const input = node("input"); input.type = "checkbox"; input.value = agent.id;
      input.dataset.focusKey = `recipient:${agent.id}`;
      input.checked = selected.has(agent.id); input.disabled = !canMessage() || state.sending;
      appendOwned(label, () => (input), () => (node("span", "", () => (`${agent.name} (${agent.id})`))));
      return label;
    }));
    if (!recipients.length) appendOwned($("recipient-list"), () => (node("p", "field-help", () => (tr("No other available agents in this channel.")))));
    syncComposerAddressing();
  }

  function clearNativeReceipts() {
    state.nativeReceiptsSeq += 1;
    state.nativeReceipts = new Map(); state.nativeReceiptIDs = new Set();
    state.nativeReceiptsChannel = ""; state.nativeReceiptsStatus = "pending";
  }

  function nativeReceiptTime(value) {
    if (value === null) return true;
    if (typeof value !== "string") return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
    if (!match || !Number.isFinite(Date.parse(value))) return false;
    const month = Number(match[2]), day = Number(match[3]);
    return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate();
  }

  function validateNativeReceipts(data, messages, channelId) {
    if (!data || !Array.isArray(data.receipts)) throw new Error("Invalid native receipt snapshot");
    const scope = new Map(messages.map(message => [message.id, message]));
    const result = new Map();
    for (const row of data.receipts) {
      const message = row && scope.get(row.message_id);
      if (!message || message.channel_id !== channelId || typeof row.agent_id !== "string" ||
          !list(message.recipient_ids).includes(row.agent_id) || row.provenance !== "client_reported" || row.server_verified !== false ||
          ![row.offered_at, row.seen_at, row.accepted_at].every(nativeReceiptTime) ||
          ![row.offered_at, row.seen_at, row.accepted_at].some(Boolean)) throw new Error("Out-of-scope or invalid native receipt");
      if (!result.has(message.id)) result.set(message.id, new Map());
      const recipients = result.get(message.id);
      if (recipients.has(row.agent_id)) throw new Error("Duplicate native receipt");
      recipients.set(row.agent_id, {offered_at: row.offered_at, seen_at: row.seen_at, accepted_at: row.accepted_at});
    }
    return result;
  }

  async function loadNativeReceipts(context, channelId) {
    const authVersion = state.authVersion, request = ++state.nativeReceiptsSeq;
    const valid = () => current(context) && authVersion === state.authVersion && state.channel?.id === channelId && request === state.nativeReceiptsSeq;
    if (!valid()) return;
    const messages = [...state.messages.values()].filter(message => message.channel_id === channelId);
    const receipts = new Map();
    try {
      for (let index = 0; index < messages.length; index += 100) {
        const batch = messages.slice(index, index + 100);
        const query = batch.map(message => `message_id=${pathId(message.id)}`).join("&");
        const data = await api(`/v1/channels/${pathId(channelId)}/native-receipts?${query}`);
        if (!valid()) return;
        for (const [id, rows] of validateNativeReceipts(data, batch, channelId)) receipts.set(id, rows);
      }
      if (!valid()) return;
      // Messages are immutable, but access/context and the loaded window can change
      // while a batch is in flight. Never attach old reports to a replaced scope.
      for (const message of messages) {
        const loaded = state.messages.get(message.id);
        if (!loaded || loaded.channel_id !== channelId || list(message.recipient_ids).some(id => !list(loaded.recipient_ids).includes(id))) return;
      }
      state.nativeReceipts = receipts; state.nativeReceiptIDs = new Set(messages.map(message => message.id));
      state.nativeReceiptsChannel = channelId; state.nativeReceiptsStatus = "ready";
    } catch (error) {
      if (!valid()) return;
      state.nativeReceipts = new Map(); state.nativeReceiptIDs = new Set();
      state.nativeReceiptsChannel = channelId; state.nativeReceiptsStatus = "unavailable";
      // Preserve the existing access-loss clearing path; a denied aggregate is
      // never interpreted as an empty set of reports.
      if ([401, 403, 404].includes(error.status)) throw error;
    }
  }

  function nativeReceiptFor(message, agentId) {
    if (state.nativeReceiptsChannel !== message.channel_id || state.channel?.id !== message.channel_id ||
        !list(message.recipient_ids).includes(agentId)) return null;
    return state.nativeReceipts.get(message.id)?.get(agentId) || null;
  }

  function messageReceiptSummary(message, agentId) {
    const receipt = list(message.receipts).find(item => item.agent_id === agentId) || {};
    const native = nativeReceiptFor(message, agentId);
    const legacy = receipt.uncertain_at ? tr("⚠ uncertain") : receipt.accepted_at ? tr("accepted, not necessarily completed") : receipt.delivered_at ? tr("delivered") : null;
    const report = native?.accepted_at ? tr("accepted, not necessarily completed · connector report") : native?.seen_at ? tr("viewed · connector report") : native?.offered_at ? tr("offered to the CLI · connector report") : null;
    if (report && legacy) return joinText([report, tr("Legacy: {0}", legacy)], " · ");
    if (!report && state.nativeReceiptsChannel === message.channel_id && state.channel?.id === message.channel_id && state.nativeReceiptsStatus === "unavailable") {
      const unavailable = tr("connector status unavailable");
      return legacy ? joinText([legacy, unavailable], " · ") : unavailable;
    }
    return report || legacy || tr("stored, delivery unconfirmed");
  }

  function renderNativeReceipt(message, agentId) {
    const section = node("div", "native-receipt");
    const native = nativeReceiptFor(message, agentId);
    const status = state.nativeReceiptsChannel === message.channel_id ? state.nativeReceiptsStatus : "pending";
    const loaded = status === "ready" && state.nativeReceiptIDs.has(message.id);
    section.dataset.nativeReceipt = native?.accepted_at ? "accepted" : native?.seen_at ? "seen" : native?.offered_at ? "offered" : loaded ? "none" : status === "unavailable" ? "unavailable" : "pending";
    appendOwned(section, () => node("p", "receipt-source", () => tr("Connector reports")));
    if (loaded) {
      const statuses = node("div", "receipt-states");
      for (const [stage, name, time] of [["offered", tr("Offered to the CLI"), native?.offered_at], ["seen", tr("Viewed"), native?.seen_at], ["accepted", tr("Reported acceptance"), native?.accepted_at]]) {
        const item = node("span", "receipt-state", () => formatText(["", ": ", ""], name, time ? dateText(time) : tr("No connector report")));
        item.dataset.confirmed = String(Boolean(time)); item.dataset.nativeStage = stage;
        appendOwned(statuses, () => item);
      }
      appendOwned(section, () => statuses);
    } else appendOwned(section, () => node("p", "", () => status === "unavailable" ? tr("Connector reports are unavailable; native status is unknown.") : tr("Connector reports have not been loaded yet.")));
    appendOwned(section, () => node("p", "receipt-boundary", () => tr("According to the connector; not independently verified by the server. Times show the first server record of each report. Offered, viewed and accepted are separate reports; none proves completion.")));
    return section;
  }

  function renderMessages() {
    const messages = [...state.messages.values()].sort((a, b) => number(a.seq) - number(b.seq));
    const query = $("search-input").value.trim().toLocaleLowerCase(localeName());
    const shown = messages.filter((message) => !query || `${message.body} ${message.author_id} ${displayName(message.author_id)}`.toLocaleLowerCase(localeName()).includes(query));
    const scroller = $("message-list");
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 45;
    const previousScroll = scroller.scrollTop;
    const openedDetails = new Set([...scroller.querySelectorAll(".message-details[open]")].map((item) => item.dataset.messageId));
    replaceContent("message-list", ...shown.map((message) => {
      const article = node("article", "message"); article.dataset.messageId = message.id; article.dataset.messageSeq = String(message.seq);
      if (state.highlightMessage === message.id) { article.dataset.alertTarget = "true"; article.dataset.focusKey = `alert-message:${message.id}`; article.tabIndex = -1; }
      const content = node("div", "message-content");
      const meta = node("div", "message-meta");
      appendOwned(meta, () => (node("span", "message-author", () => (displayName(message.author_id)))), () => (node("time", "message-time", () => (dateText(message.created_at)))));
      appendOwned(content, () => (meta));
      if (message.reply_to) appendOwned(content, () => (node("p", "message-reply", () => (tr("Reply to ID {0} · not a new automatic invocation", () => (message.reply_to))))));
      appendOwned(content, () => (node("p", "message-text", () => (message.body))));
      const details = node("details", "message-details"); details.dataset.messageId = message.id; details.open = openedDetails.has(message.id);
      const recipients = list(message.recipient_ids);
      const summary = node("summary", "receipt-summary"); summary.dataset.focusKey = `receipt:${message.id}`;
      const receiptLabels = recipients.map((id) => {
        return formatText(["",": ",""], () => (displayName(id)), () => messageReceiptSummary(message, id));
      });
      setText(summary, () => (receiptLabels.length ? joinText(receiptLabels, " · ") : tr("Stored in the channel · no adapter invocation")));
      summary.dataset.uncertain = String(list(message.receipts).some((receipt) => receipt.uncertain_at));
      appendOwned(details, () => (summary), () => (node("p", "message-id", () => (tr("ID {0} · seq {1} · stored {2}", () => (message.id), () => (message.seq), () => (dateText(message.created_at)))))));
      if (recipients.length) {
        const receipts = node("div", "receipt-list");
        for (const id of recipients) {
          const receipt = list(message.receipts).find((item) => item.agent_id === id) || {};
          const row = node("div", "receipt-row");
          appendOwned(row, () => (node("span", "receipt-name", () => formatText(["", " · ", ""], displayName(id), id))));
          appendOwned(row, () => renderNativeReceipt(message, id), () => node("p", "receipt-source", () => tr("Legacy confirmations")));
          const statuses = node("div", "receipt-states");
          for (const [name, time, uncertain] of [
            [tr("Stored"), message.created_at, false], [tr("Delivered"), receipt.delivered_at, false],
            [tr("Accepted"), receipt.accepted_at, false], [tr("Uncertain"), receipt.uncertain_at, true],
          ]) {
            const status = node("span", "receipt-state", () => (formatText(["",": ",""], () => (name), () => (time ? dateText(time) : tr("unconfirmed")))));
            status.dataset.confirmed = String(Boolean(time));
            if (uncertain && time) status.dataset.uncertain = "true";
            appendOwned(statuses, () => (status));
          }
          appendOwned(row, () => (statuses));
          if (receipt.uncertain_at) appendOwned(row, () => (node("p", "", () => (tr("Operator review is required. Automatic execution retry is unconfirmed.")))));
          if (receipt.session_id) appendOwned(row, () => (node("p", "", () => (tr("Receipt session: {0}", () => (receipt.session_id))))));
          appendOwned(receipts, () => (row));
        }
        appendOwned(details, () => (receipts));
      } else appendOwned(details, () => (node("p", "message-id", () => (tr("No recipients · stored in the channel without an automatic adapter invocation")))));
      appendOwned(content, () => (details));
      if (canMessage()) {
        const reply = node("button", "reply-action", () => (tr("Reply ↗")));
        reply.dataset.focusKey = `reply:${message.id}`;
        reply.type = "button"; reply.disabled = state.sending;
        reply.addEventListener("click", () => { selectReply(message.id); $("message-input").focus(); });
        appendOwned(content, () => (reply));
      }
      appendOwned(article, () => (avatar(message.author_id)), () => (content));
      return article;
    }));
    if (!shown.length) appendOwned(scroller, () => (node("p", "empty-state", () => (state.loading ? tr("Loading messages…") : !state.dataReady ? tr("Messages have not been received yet. Check the connection status.") : query ? tr("No matches in loaded messages.") : tr("No messages in this channel yet.")))));
    setText($("message-count"), () => (query ? `${shown.length}/${messages.length}` : String(messages.length)));
    const replyValue = $("reply-to").value;
    const initial = node("option", "", () => (tr("New message"))); initial.value = "";
    replaceContent("reply-to", initial, ...messages.map((message) => {
      const option = node("option", "", () => formatText(["", " · ", " · ID ", ""], displayName(message.author_id), String(message.body).slice(0, 48), message.id));
      option.value = message.id; return option;
    }));
    if (state.messages.has(replyValue)) $("reply-to").value = replyValue;
    scroller.scrollTop = atBottom ? scroller.scrollHeight : previousScroll;
    scheduleChannelRead();
  }

  function renderEvents() {
    const labels = {"message.created": tr("Message stored"), "receipt.delivered": tr("Delivery confirmed"), "receipt.accepted": tr("Acceptance confirmed"), "receipt.uncertain": tr("Uncertainty recorded"), "native.activity": tr("CLI activity report stored · details in a separate tab")};
    const loaded = [...state.events.values()].sort((a, b) => number(b.seq) - number(a.seq));
    const events = loaded.filter(event => state.showTechnicalEvents || event.kind !== "native.activity");
    const hidden = loaded.length - events.length;
    replaceContent("activity-list", ...events.map((event) => {
      const row = node("article", "activity-row");
      appendOwned(row, () => (node("h3", "activity-title", () => (labels[event.kind] || event.kind))), () => (node("p", "activity-meta", () => (tr("#{0} · {1} · seq {2}\nEntity: {3}", () => (state.channel?.name || event.channel_id), () => (dateText(event.created_at)), () => (event.seq), () => (event.entity_id || "—"))))));
      return row;
    }));
    if (!events.length) appendOwned($("activity-list"), () => (node("p", "empty-state", () => (state.loading ? tr("Loading events…") : hidden ? tr("Only technical events are loaded. Turn on “Show technical events” to view them.") : state.dataReady ? tr("No events received for this channel yet.") : tr("Events have not been received yet.")))));
    renderTechnicalNotice("activity-technical-notice", hidden);
    setText($("activity-scope"), () => (state.channel ? tr("Only #{0}. Showing up to 200 events received in this view.", () => (state.channel.name)) : tr("No channel selected.")));
  }

  function renderNotes() {
    $("notes-truncated").hidden = !state.notesTruncated;
    replaceContent("memory-list", ...state.notes.map((note) => {
      const article = node("article", "note-card");
      appendOwned(article, () => (node("p", "note-eyebrow", () => (tr("PROJECT NOTE · VERSION {0} · IMMUTABLE", () => (note.version || 1))))), () => (node("h3", "note-title", () => (note.title))), () => (node("p", "note-text", () => (note.body))), () => (node("p", "note-footer", () => (tr("{0} · {1}\nProject: {2} ({3}) · ID {4}", () => (displayName(note.author_id)), () => (dateText(note.created_at)), () => (state.project?.name || note.project_id), () => (note.project_id), () => (note.id))))));
      if (note.source_message_id) appendOwned(article, () => (node("p", "note-footer", () => (tr("Source: message ID {0}", () => (note.source_message_id))))));
      return article;
    }));
    if (!state.notes.length) appendOwned($("memory-list"), () => (node("p", "empty-state", () => (state.loading ? tr("Loading notes…") : state.dataReady ? tr("No published notes in this project yet.") : tr("Notes have not been received yet.")))));
    setText($("notes-destination"), () => (state.project ? tr("Destination: the entire project “{0}” ({1}).", () => (state.project.name), () => (state.project.id)) : tr("No project selected.")));
  }

  // The map consumes one bounded, server-authorized metadata snapshot. Edges are
  // never inferred by matching arbitrary IDs, timestamps, names or activity.
  function clearProjectMap() {
    state.projectMap = null; state.projectMapEpoch += 1;
    setText($("project-map-live-title"), () => tr("Selected project"));
    for (const id of ["project-map-counts", "project-map-entities", "project-map-detail", "project-map-relations"]) $(id).replaceChildren();
    for (const id of ["project-map-status", "project-map-boundary", "project-map-list-status", "project-map-relations-status", "project-map-technical-notice"]) setText($(id), () => (""));
    $("project-map-technical-notice").dataset.hiddenCount = "0";
    $("project-map-relations-status").dataset.hiddenCount = "0";
    delete $("project-map-detail").dataset.entityKey;
    $("project-map-type").value = ""; $("project-map-search").value = "";
    clearError("project-map-error");
  }

  function projectMapData() {
    if (!state.project) return null;
    if (state.projectMap?.projectId !== state.project.id) {
      clearProjectMap();
      state.projectMap = {projectId: state.project.id, snapshot: null, type: "", query: "", selectedKey: "", loading: false, error: "", notice: "", scope: ""};
    }
    return state.projectMap;
  }

  function syncProjectMapScope() {
    const data = state.projectMap; if (!data || data.projectId !== state.project?.id) return;
    const scope = JSON.stringify(state.channels.map(channel => [channel.id, channel.can_write === true]).sort((a, b) => a[0].localeCompare(b[0])));
    if (data.scope && scope !== data.scope) {
      state.projectMapEpoch += 1; data.snapshot = null; data.selectedKey = ""; data.loading = false; data.error = "";
      data.notice = tr("Available channels have changed. The previous map has been cleared.");
    }
    data.scope = scope; renderProjectMap();
  }

  function validProjectMap(value, projectId) {
    if (value?.read_only !== true || value.project?.id !== projectId || typeof value.generated_at !== "string" || !Number.isFinite(Date.parse(value.generated_at)) ||
      !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.groups) || value.nodes.length > Object.keys(MAP_TYPES).length * 25 || value.edges.length > 10000) return false;
    const keys = new Set(), counts = new Map();
    for (const item of value.nodes) {
      if (!item || !Object.hasOwn(MAP_TYPES, item.type) || typeof item.key !== "string" || !item.key || keys.has(item.key) || typeof item.id !== "string" || typeof item.label !== "string" ||
        !item.meta || typeof item.meta !== "object" || Array.isArray(item.meta) || item.meta.project_id !== projectId) return false;
      keys.add(item.key); counts.set(item.type, (counts.get(item.type) || 0) + 1);
    }
    const groups = new Set();
    for (const group of value.groups) {
      if (!Object.hasOwn(MAP_TYPES, group.type) || groups.has(group.type) || !Number.isSafeInteger(group.total) || group.total < 0 || !Number.isSafeInteger(group.shown) ||
        group.shown < 0 || group.shown > 25 || group.shown > group.total || group.shown !== (counts.get(group.type) || 0) || typeof group.truncated !== "boolean" || group.truncated !== (group.total > group.shown)) return false;
      groups.add(group.type);
    }
    if (groups.size !== Object.keys(MAP_TYPES).length) return false;
    return value.edges.every(edge => edge && keys.has(edge.source) && keys.has(edge.target) && typeof edge.kind === "string" && typeof edge.label === "string");
  }

  async function projectMapSnapshot(context) {
    const data = projectMapData(); if (!data) return;
    const epoch = state.projectMapEpoch;
    const matches = () => current(context) && state.view === "project-map" && state.project?.id === data.projectId && state.projectMap === data && state.projectMapEpoch === epoch;
    data.loading = true; renderProjectMap();
    try {
      const response = await api(`/v1/projects/${pathId(data.projectId)}/map?limit=25`);
      if (!matches()) return;
      if (!validProjectMap(response, data.projectId)) throw new ApiError(502, tr("The API returned an invalid project map snapshot. Relationships are unconfirmed."));
      data.snapshot = response; data.error = "";
    } catch (error) {
      if (!matches()) return;
      if ([401, 403, 404].includes(error.status)) { clearProjectMap(); throw error; }
      data.error = errorText(error); throw error;
    } finally { if (matches()) { data.loading = false; renderProjectMap(); } }
  }

  // Only API-defined synthetic labels are localized. Project/account/channel
  // names and task/memory/note titles remain the exact untrusted user data.
  function mapNodeLabel(item) {
    const meta = item.meta;
    if (item.type === "message") return tr("Message {0}", item.id);
    if (item.type === "receipt") return tr("Delivery status · {0}", meta.agent_id);
    if (item.type === "session") return tr("Session lease {0}", meta.session_id);
    if (item.type === "run") return tr("Task run {0}", meta.run_id);
    if (item.type === "artifact") return meta.title || tr("Artifact {0} · {1}", ARTIFACT_ROLES[meta.role] || meta.role, item.id);
    if (item.type === "task-event") return TASK_EVENTS[meta.type] || item.label;
    if (item.type === "native") return nativeEventLabel(meta.type) || item.label;
    return item.label;
  }

  function mapEdgeLabel(edge, source, target) {
    if (edge.kind === "authored") return tr(target.type === "message" ? "Message author" : "Publication author");
    if (edge.kind === "reported") return tr(target.type === "native" ? "CLI report author" : "Task event author");
    if (edge.kind === "review_request") return tr(source.type === "run" ? "Run review request" : "Review request response");
    const labels = {project_member: "Project member", project_contains: "In project", channel_member: "Channel member", channel_contains: "In channel",
      reply_to: "Reply to message", recipient: "Recipient", receipt_for: "Recipient delivery status", receipt_actor: "Message recipient",
      reported_message: "Message report", session_actor: "Lease account", task_owner: "Assigned task owner", task_reviewer: "Assigned reviewer",
      created: "Task creator", current_run: "Current task run", task_run: "Task run", task_event: "Task event", run_event: "Run event",
      artifact_ref: "Published artifact reference", evidence_ref: "External report artifact", updated: "Current version author", memory_version: "Memory version", source_message: "Note source"};
    return Object.hasOwn(labels, edge.kind) ? tr(labels[edge.kind]) : edge.label;
  }

  function nativeEventLabel(type) {
    const labels = {"session.started": "CLI session start reported", "session.ended": "CLI session end reported", "turn.started": "Turn start reported", "turn.completed": "Turn completion reported", "tool.started": "Tool start observed", "tool.completed": "Tool completion observed", "tool.failed": "Tool failure reported", "agent.waiting": "Adapter reports waiting", "inbox.offered": "Message offered to a CLI session", "inbox.seen": "Session explicitly reported message viewed", "inbox.accepted": "Session explicitly reported message acceptance"};
    return Object.hasOwn(labels, type) ? tr(labels[type]) : null;
  }

  function mapEntityButton(item, className = "map-entity") {
    const button = node("button", className); button.type = "button";
    button.dataset.entityKey = item.key; button.dataset.entityType = item.type; button.dataset.entityId = item.id;
    button.dataset.focusKey = `map:${className}:${item.key}`;
    button.setAttribute("aria-pressed", String(state.projectMap?.selectedKey === item.key));
    appendOwned(button, () => (node("span", "map-entity-type", () => (MAP_TYPES[item.type]))), () => (node("strong", "", () => (mapNodeLabel(item)))), () => (node("span", "map-entity-id", () => (item.id))));
    button.addEventListener("click", () => focusMapEntity(item.key)); return button;
  }

  function selectMapType(type, focus = false) {
    const data = projectMapData(); if (!data || type && !Object.hasOwn(MAP_TYPES, type)) return;
    data.type = type; data.query = ""; data.selectedKey = "";
    $("project-map-type").value = type; $("project-map-search").value = ""; renderProjectMap();
    if (focus) { $("project-map-live").scrollIntoView({block: "start"}); $("project-map-type").focus({preventScroll: true}); }
  }

  function focusMapEntity(key) {
    const data = state.projectMap, item = data?.snapshot?.nodes.find(entry => entry.key === key);
    if (!item || state.view !== "project-map") return;
    data.selectedKey = key; data.type = item.type; data.query = "";
    $("project-map-type").value = item.type; $("project-map-search").value = ""; renderProjectMap();
    $("project-map-detail").focus({preventScroll: true});
  }

  function mapNavigation(item) {
    const meta = item.meta;
    if (item.type === "project") return {view: "overview", label: tr("Open project overview")};
    if (["channel", "message", "receipt"].includes(item.type) && state.channels.some(channel => channel.id === meta.channel_id)) return {view: "chat", channelId: meta.channel_id, label: tr("Open discussion channel")};
    if (item.type === "native") return {view: "project-native", channelId: meta.channel_id, label: tr("Open this channel’s CLI feed")};
    if (["task", "run", "task-event"].includes(item.type) && meta.task_id) return {view: "tasks", entityId: meta.task_id, label: tr("Open task and history")};
    if (["memory", "memory-version"].includes(item.type) && meta.memory_id) return {view: "memory", entityId: meta.memory_id, label: tr("Open memory and versions")};
    if (item.type === "artifact") return {view: "artifacts", label: tr("Open artifacts section")};
    if (item.type === "note") return {view: "notes", label: tr("Open project notes")};
    if (item.type === "session") return {view: "sessions", label: tr("Open session leases")};
    return null;
  }

  async function openMapTarget(key) {
    const data = state.projectMap, item = data?.snapshot?.nodes.find(entry => entry.key === key);
    if (state.view !== "project-map" || !item || data.error || state.adminBusy || state.coordinationBusy) return;
    const target = mapNavigation(item); if (!target) return;
    if (target.view === "overview") { await selectOverview(); return; }
    if (target.view === "chat") { const channel = state.channels.find(entry => entry.id === target.channelId); if (channel) await selectChannel(channel); return; }
    if (target.view === "project-native") { await selectProjectNative(target.channelId); return; }
    if (target.view === "notes") { await selectNotes(); return; }
    const coordination = coordinationData();
    if (target.view === "tasks" && target.entityId !== coordination.taskId) {
      if (coordination.eventDraft && !window.confirm(tr("Open another task and discard the current unpublished event draft?"))) return;
      selectTaskData(coordination, target.entityId);
    }
    if (target.view === "tasks") coordination.mapTaskTarget = target.entityId;
    if (target.view === "memory" && target.entityId !== coordination.memoryId) {
      if (coordination.memoryDraft && !window.confirm(tr("Open another memory entry and discard the current unpublished draft?"))) return;
      closeMemoryDraft(); coordination.memoryId = target.entityId; coordination.memoryDetail = null; state.coordinationEpoch += 1;
    }
    if (target.view === "memory") coordination.mapMemoryTarget = target.entityId;
    await selectCoordination(target.view);
  }

  function renderProjectMapDetail(data, item) {
    const container = $("project-map-detail");
    if (!item) {
      delete container.dataset.entityKey;
      replaceContent("project-map-detail", node("p", "empty-state", () => (tr("Select an entity from the loaded snapshot."))));
      replaceContent("project-map-relations"); setText($("project-map-relations-status"), () => ("")); $("project-map-relations-status").dataset.hiddenCount = "0"; return;
    }
    container.dataset.entityKey = item.key;
    const card = node("article", "map-detail-card"); card.dataset.entityKey = item.key; card.dataset.entityType = item.type; card.dataset.entityId = item.id;
    appendOwned(card, () => (node("p", "eyebrow", () => (MAP_TYPES[item.type]))), () => (node("h3", "", () => (mapNodeLabel(item)))), () => (node("p", "map-entity-id", () => (`ID: ${item.id}`))));
    const metadata = node("dl", "map-metadata");
    for (const [key, label] of Object.entries(MAP_META)) {
      const value = item.meta[key];
      if (value === null || value === undefined || typeof value === "object" && !Array.isArray(value)) continue;
      const text = Array.isArray(value) ? value.filter(entry => ["string", "number", "boolean"].includes(typeof entry)).join(", ") : String(value);
      if (!text) continue;
      const row = node("div"); appendOwned(row, () => (node("dt", "", () => (label))), () => (node("dd", "", () => (text)))); appendOwned(metadata, () => (row));
    }
    appendOwned(card, () => (metadata));
    if (item.type === "native") appendOwned(card, () => (node("p", "map-caution", () => (tr("A client report, not server verification. A CLI session ID is not joined to a session lease or legacy receipt.")))));
    if (item.type === "session") appendOwned(card, () => (node("p", "map-caution", () => (tr("A lease does not prove model activity. Its run_id is a client label, not a task-run reference.")))));
    if (["receipt", "task-event", "run"].includes(item.type)) appendOwned(card, () => (node("p", "map-caution", () => (tr("A receipt or published report is not independent server verification of completion.")))));
    const target = mapNavigation(item);
    if (target) {
      const button = node("button", "secondary-button", () => (target.label)); button.type = "button"; button.dataset.targetView = target.view;
      button.dataset.targetEntityId = target.entityId || item.id; if (target.channelId) button.dataset.targetChannelId = target.channelId;
      button.dataset.focusKey = `map-open:${item.key}`; button.disabled = Boolean(data.error || state.adminBusy || state.coordinationBusy);
      button.addEventListener("click", () => void openMapTarget(item.key)); appendOwned(card, () => (button));
    }
    replaceContent("project-map-detail", card);
    const byKey = new Map(data.snapshot.nodes.map(entry => [entry.key, entry]));
    const related = data.snapshot.edges.filter(edge => edge.source === item.key || edge.target === item.key);
    // Selecting a diagnostic entity is an explicit request to inspect its links.
    const diagnosticType = ["native", "receipt"].includes(item.type) ? item.type : "";
    const edges = related.filter(edge => mapEntityVisible(byKey.get(edge.source), diagnosticType) && mapEntityVisible(byKey.get(edge.target), diagnosticType));
    const hidden = related.length - edges.length;
    const rows = edges.slice(0, 30).map(edge => {
      const row = node("div", "map-relation"); row.dataset.relationType = edge.kind; row.dataset.source = edge.source; row.dataset.target = edge.target;
      appendOwned(row, () => (mapEntityButton(byKey.get(edge.source), "map-related-entity")), () => (node("span", "map-relation-label", () => formatText(["— ", " →"], mapEdgeLabel(edge, byKey.get(edge.source), byKey.get(edge.target))))), () => (mapEntityButton(byKey.get(edge.target), "map-related-entity"))); return row;
    });
    if (!rows.length) rows.push(node("p", "empty-state", () => (hidden ? tr("Only technical relationships are loaded for this entity. Turn on “Show technical events” to view them.") : tr("No relationships among the loaded entities. This does not establish that no relationships exist beyond this bounded snapshot."))));
    replaceContent("project-map-relations", ...rows);
    $("project-map-relations-status").dataset.hiddenCount = String(hidden);
    setText($("project-map-relations-status"), () => formatText(["", "", ""], () => tr("Showing {0} of {1} relationships for the selected entity among loaded entities. Entities outside the sample and their relationships are not shown.", () => Math.min(30, edges.length), () => edges.length), () => hidden ? tr(" {0} technical relationships hidden. Turn on “Show technical events” to view them.", () => hidden) : ""));
  }

  function renderProjectMap() {
    if (state.view !== "project-map") return;
    const data = projectMapData(); if (!data) return;
    const snapshot = data.snapshot, confirmed = Boolean(snapshot && !data.error);
    $("project-map-admin").hidden = !isOwner();
    setText($("project-map-live-title"), () => (tr("In project “{0}”", () => (state.project.name))));
    setText($("project-map-status"), () => (data.error ? snapshot ? tr("Refresh is unconfirmed. Previous snapshot: {0}", () => (snapshot.generated_at)) : tr("No snapshot received; absence of entities has not been established.") : snapshot ? tr("{0}Snapshot: {1}", () => (data.loading ? tr("Updating… ") : ""), () => (snapshot.generated_at)) : tr("Reading the authorized project map…")));
    setText($("project-map-error"), () => (data.error)); $("project-map-error").hidden = !data.error;
    setText($("project-map-boundary"), () => (tr("{0} Counts include only data available to you. The map loads at most 25 entities of each type; relationships are shown only between loaded entities. A missing map edge does not establish that the relationship is absent from the project. Access, keys, and audit above are explanatory concepts, not records in this snapshot.", () => (data.notice)).trim()));
    replaceContent("project-map-counts", ...Object.entries(MAP_TYPES).map(([type, label]) => {
      const group = snapshot?.groups.find(entry => entry.type === type), button = node("button", "map-count"); button.type = "button";
      button.dataset.entityType = type; button.dataset.focusKey = `map-count:${type}`;
      button.dataset.countState = data.error ? snapshot ? "stale" : "error" : !group ? "loading" : group.truncated ? "partial" : "ready";
      if (confirmed && group) { button.dataset.countValue = String(group.total); button.dataset.countShown = String(group.shown); }
      button.setAttribute("aria-pressed", String(data.type === type));
      appendOwned(button, () => (node("span", "", () => (label))), () => (node("strong", "", () => (group ? tr("{0} of {1}", () => (group.shown), () => (group.total)) : "—"))), () => (node("small", "", () => (data.error ? tr("Refresh unconfirmed") : group?.truncated ? tr("Bounded sample") : group ? tr("Within your access scope") : tr("Not received yet")))));
      button.addEventListener("click", () => selectMapType(type)); return button;
    }));
    const all = node("option", "", () => (tr("All types"))); all.value = "";
    replaceContent("project-map-type", all, ...Object.entries(MAP_TYPES).map(([type, label]) => { const option = node("option", "", () => (label)); option.value = type; return option; }));
    $("project-map-type").value = data.type;
    const query = data.query.trim().toLocaleLowerCase(localeName());
    const matching = list(snapshot?.nodes).filter(item => (!data.type || item.type === data.type) && (!query || `${mapNodeLabel(item)} ${item.label} ${item.id}`.toLocaleLowerCase(localeName()).includes(query)));
    const matches = matching.filter(item => mapEntityVisible(item, data.type));
    const hidden = matching.length - matches.length;
    const shown = matches.slice(0, 100);
    if (!shown.some(item => item.key === data.selectedKey)) data.selectedKey = (shown.find(item => item.type === "project") || shown[0])?.key || "";
    const cards = shown.map(item => mapEntityButton(item));
    if (!cards.length) cards.push(node("p", "empty-state", () => (!snapshot ? data.error ? tr("Data is unconfirmed; a zero count has not been established.") : tr("Loading metadata…") : hidden ? tr("Only technical entities match in this loaded sample. Select their type or show technical events to view them.") : query ? tr("No matches in the loaded snapshot. Search does not cover entities outside the sample.") : tr("No entities of this type in the loaded sample."))));
    replaceContent("project-map-entities", ...cards);
    setText($("project-map-list-status"), () => (snapshot ? tr("Listing {0} of {1} matching snapshot entities.{2}", () => (shown.length), () => (matches.length), () => (matches.length > 100 ? tr(" Select a type or refine the search: the list is limited to 100 rows.") : "")) : ""));
    renderTechnicalNotice("project-map-technical-notice", hidden, true);
    renderProjectMapDetail(data, shown.find(item => item.key === data.selectedKey));
  }

  async function selectProjectMap() {
    if (!state.project || state.adminBusy || state.coordinationBusy || state.view === "project-map") return;
    stopNetwork(); clearError(); clearProjectMap(); setView("project-map"); await refresh();
  }

  function clearNativeActivity() {
    state.nativeActivity.clear(); state.nativeSeq = 0; state.nativeReady = false; state.nativeMore = false; state.nativeWindowAfter = 0;
    $("native-activity-list").replaceChildren(); setText($("native-activity-scope"), () => ("")); setText($("native-history-notice"), () => (""));
    setText($("native-technical-notice"), () => ""); $("native-technical-notice").dataset.hiddenCount = "0";
  }

  // Project activity has its own newest-first cursor, never the shared channel seq.
  // Every refresh re-reads the requested (one/two page) window from its newest edge.
  function clearProjectNative() {
    state.projectNative = null; state.projectNativeEpoch += 1;
    $("project-native-list").replaceChildren();
    for (const [id, label] of [["project-native-actor", tr("All available agents")], ["project-native-channel", tr("All available channels")]]) {
      const option = node("option", "", () => (label)); option.value = ""; $(id).replaceChildren(option); $(id).disabled = true;
    }
    for (const id of ["project-native-scope", "project-native-status", "project-native-last-event", "project-native-technical-notice"]) setText($(id), () => (""));
    $("project-native-technical-notice").dataset.hiddenCount = "0";
    $("project-native-last-event").dataset.freshness = "unknown";
    $("project-native-more").hidden = true; $("project-native-more").disabled = true;
    clearError("project-native-error");
  }

  function projectNativeData() {
    if (!state.project) return null;
    if (state.projectNative?.projectId !== state.project.id) {
      clearProjectNative();
      state.projectNative = {projectId: state.project.id, actorId: "", channelId: "", rows: [], pages: 1,
        ready: false, loading: false, hasMore: false, nextBefore: null, error: "", notice: "", at: null, scope: ""};
    }
    return state.projectNative;
  }

  function projectNativeAgents() { return state.agents.filter((agent) => agent.kind === "agent"); }

  function resetProjectNative(actorId = "", channelId = "", notice = "") {
    clearProjectNative();
    const data = projectNativeData();
    if (!data) return;
    data.actorId = actorId; data.channelId = channelId; data.notice = notice;
    syncProjectNativeScope(); renderProjectNative();
  }

  function syncProjectNativeScope() {
    const data = state.projectNative;
    if (!data || data.projectId !== state.project?.id) return;
    const channelIds = state.channels.map(channel => channel.id).sort();
    const actorIds = projectNativeAgents().map(agent => agent.id).sort();
    const scope = JSON.stringify([channelIds, actorIds]);
    if (data.scope && data.scope !== scope) {
      // Purge all pages even when a revoked channel was not the selected chat.
      state.projectNativeEpoch += 1; data.rows = []; data.ready = false; data.loading = false;
      data.pages = 1; data.hasMore = false; data.nextBefore = null; data.at = null; data.error = "";
      data.notice = tr("Available project membership has changed. The old window was cleared; rereading permitted events.");
      if (data.channelId && !channelIds.includes(data.channelId)) data.channelId = "";
      if (data.actorId && !actorIds.includes(data.actorId)) data.actorId = "";
    }
    data.scope = scope;
    renderProjectNative();
  }

  function projectNativeCard(event) {
    const labels = {"session.started": tr("CLI session started"), "session.ended": tr("CLI session ended"), "turn.started": tr("Turn started"), "turn.completed": tr("Turn completed"), "tool.started": tr("Tool started"), "tool.completed": tr("Tool completed"), "tool.failed": tr("Tool failed"), "agent.waiting": tr("Adapter waiting"), "inbox.offered": tr("Message offered to CLI"), "inbox.seen": tr("CLI reported message viewed"), "inbox.accepted": tr("CLI reported message acceptance")};
    const row = node("article", "native-activity-record");
    row.dataset.nativeId = event.id; row.dataset.channelId = event.channel_id; row.dataset.nativeType = event.event_type;
    row.dataset.actorId = event.actor_id; row.dataset.sessionId = event.session_id;
    const channel = state.channels.find(item => item.id === event.channel_id);
    appendOwned(row, () => (node("h2", "activity-title", () => (labels[event.event_type] || tr("Client report")))), () => (node("p", "activity-meta", () => formatText(["", " · #", " · ", ""], displayName(event.actor_id), channel?.name || event.channel_id, event.runtime))), () => (node("p", "native-provenance", () => (tr("Client-reported · not server-verified")))));
    const time = node("time", "project-native-event-time", () => (tr("Stored: {0}", () => (event.created_at)))); time.dateTime = event.created_at; appendOwned(row, () => (time));
    if (event.tool_name) appendOwned(row, () => (node("p", "native-tool-name", () => (tr("Tool: {0}", () => (event.tool_name))))));
    const details = node("details", "message-details");
    appendOwned(details, () => (node("summary", "receipt-summary", () => (tr("Event identifiers")))), () => (node("p", "activity-meta", () => (tr("ID {0}\nAgent: {1} · channel: {2}\nCLI session: {3}{4}", () => (event.id), () => (event.actor_id), () => (event.channel_id), () => (event.session_id), () => (event.message_id ? tr("\nRelated message: {0}", () => (event.message_id)) : "")))))); appendOwned(row, () => (details));
    if (event.event_type === "turn.completed") appendOwned(row, () => (node("p", "native-boundary", () => (tr("Turn completion does not confirm task completion or passing checks.")))));
    if (event.event_type === "inbox.offered") appendOwned(row, () => (node("p", "native-boundary", () => (tr("Offered does not mean accepted by the model. Delivery and legacy receipts are tracked separately.")))));
    if (event.event_type === "inbox.seen") appendOwned(row, () => (node("p", "native-boundary", () => (tr("Viewed does not mean accepted or completed; legacy receipts are unchanged.")))));
    if (event.event_type === "inbox.accepted") appendOwned(row, () => (node("p", "native-boundary", () => (tr("An acceptance report is not proof of completion.")))));
    return row;
  }

  function renderProjectNativeFreshness() {
    if (state.view !== "project-native") return;
    const data = state.projectNative, target = $("project-native-last-event");
    const latest = data?.rows[0];
    target.replaceChildren();
    if (!data?.ready) { target.dataset.freshness = "unknown"; setText(target, () => (tr("Last event: data has not been confirmed yet."))); return; }
    if (!latest) { target.dataset.freshness = data.error ? "unknown" : "empty"; setText(target, () => (data.error ? tr("Last event: refresh is unconfirmed. The previous snapshot was empty; current absence of events has not been established.") : tr("Last event: no reports in the selected scope. This does not mean the agent has stopped."))); return; }
    const stale = Date.now() - Date.parse(latest.created_at) > PROJECT_NATIVE_FRESH_MS;
    target.dataset.freshness = data.error ? "unknown" : stale ? "stale" : "fresh";
    const time = node("time", "", () => (latest.created_at)); time.dateTime = latest.created_at;
    appendOwned(target, () => (tr("Last event in the selected scope: ")), () => (time), () => (data.error ? tr(" · refresh unconfirmed; timestamp is from the previous snapshot.") : stale ? tr(" · no fresh events in the last 5 minutes. This does not mean the agent has stopped.") : tr(" · report stored less than 5 minutes ago; not confirmation of model activity.")));
  }

  function renderProjectNative() {
    if (state.view !== "project-native") return;
    const data = projectNativeData(); if (!data) return;
    for (const [id, label, choices, value] of [
      ["project-native-actor", tr("All available agents"), projectNativeAgents(), data.actorId],
      ["project-native-channel", tr("All available channels"), state.channels, data.channelId],
    ]) {
      const all = node("option", "", () => (label)); all.value = "";
      replaceContent(id, all, ...choices.map(item => { const option = node("option", "", () => (`${item.name || item.id} (${item.id})`)); option.value = item.id; return option; }));
      $(id).value = value; $(id).disabled = !state.projectReady;
    }
    setText($("project-native-scope"), () => (tr("Project “{0}” · {1} · {2}. {3}", () => (state.project.name), () => (data.channelId ? tr("selected channel") : tr("all available channels")), () => (data.actorId ? tr("selected agent") : tr("all authors of permitted events")), () => (data.notice))));
    const visible = data.rows.filter(nativeEventVisible), hidden = data.rows.length - visible.length;
    const rows = visible.map(projectNativeCard);
    if (!rows.length) rows.push(node("p", "empty-state", () => (data.error ? tr("Feed read is unconfirmed. See the error above; absence of events has not been established.") : hidden ? tr("Only technical events are loaded. Turn on “Show technical events” to view them.") : data.ready ? tr("No CLI reports in the selected scope yet. This does not mean the agent has stopped: the adapter may not publish events, or the filter may match no reports.") : tr("Reading the project CLI feed…"))));
    replaceContent("project-native-list", ...rows);
    setText($("project-native-error"), () => (data.error)); $("project-native-error").hidden = !data.error;
    setText($("project-native-status"), () => (tr("{0}{1}{2} Live refresh rereads a window of up to 200 events; this is not the entire archive.", () => (data.loading ? tr("Updating the window… ") : ""), () => (data.error ? tr("Refresh is unconfirmed. ") : ""), () => (data.ready ? tr("Showing {0} events, newest first. {1}{2}", () => (visible.length), () => (data.at ? tr("Snapshot: {0}. ", () => (dateText(data.at))) : ""), () => (data.hasMore ? data.rows.length >= PROJECT_NATIVE_MAX ? tr("The 200-event limit has been reached. Earlier events remain on the server; refine the filters.") : tr("Earlier events are available.") : tr("No earlier events in this snapshot."))) : tr("The first snapshot has not been received yet.")))));
    renderTechnicalNotice("project-native-technical-notice", hidden);
    $("project-native-more").hidden = !data.ready || !data.hasMore;
    $("project-native-more").disabled = data.loading || Boolean(data.error) || data.rows.length >= PROJECT_NATIVE_MAX;
    setText($("project-native-more"), () => (data.rows.length >= PROJECT_NATIVE_MAX ? tr("Limit: 200 events") : tr("Load earlier events")));
    renderProjectNativeFreshness();
  }

  async function projectNativeSnapshot(context) {
    const data = projectNativeData(); if (!data) return;
    const epoch = state.projectNativeEpoch;
    const matches = () => current(context) && state.view === "project-native" && state.project?.id === data.projectId && state.projectNative === data && state.projectNativeEpoch === epoch;
    const channels = new Set(state.channels.map(channel => channel.id));
    data.loading = true; renderProjectNative();
    try {
      const rows = [], ids = new Set(); let before = null, hasMore = false;
      for (let page = 0; page < data.pages; page += 1) {
        const query = new URLSearchParams({limit: String(PROJECT_NATIVE_LIMIT)});
        if (data.actorId) query.set("actor_id", data.actorId);
        if (data.channelId) query.set("channel_id", data.channelId);
        if (before) query.set("before", before);
        const response = await api(`/v1/projects/${pathId(data.projectId)}/activity?${query}`);
        if (!matches()) return;
        if (!Array.isArray(response.activity) || response.activity.length > PROJECT_NATIVE_LIMIT || typeof response.has_more !== "boolean" ||
          !(response.next_before === null || typeof response.next_before === "string" && response.next_before.length > 0 && response.next_before.length <= 4096) ||
          response.has_more && (!response.next_before || response.next_before === before || !response.activity.length)) throw new ApiError(502, tr("The API returned an invalid page of the project CLI feed."));
        for (const item of response.activity) {
          if (typeof item.id !== "string" || !item.id || ids.has(item.id) || !channels.has(item.channel_id) || (item.project_id && item.project_id !== data.projectId) || typeof item.actor_id !== "string" ||
            item.provenance !== "client_reported" || item.server_verified !== false || !Number.isFinite(Date.parse(item.created_at)) ||
            data.actorId && item.actor_id !== data.actorId || data.channelId && item.channel_id !== data.channelId) throw new ApiError(502, tr("The API returned an incorrect scope or attribution for the project CLI feed."));
          ids.add(item.id); rows.push(item);
        }
        hasMore = response.has_more; before = response.next_before;
        if (!hasMore || rows.length >= PROJECT_NATIVE_MAX) break;
      }
      if (!matches()) return;
      data.rows = rows.slice(0, PROJECT_NATIVE_MAX); data.hasMore = hasMore; data.nextBefore = before;
      data.ready = true; data.error = ""; data.at = new Date().toISOString();
    } catch (error) {
      if (!matches()) return;
      // Authorization failures use the existing global purge/reconciliation path.
      if ([401, 403, 404].includes(error.status)) { clearProjectNative(); throw error; }
      data.error = errorText(error); throw error;
    } finally { if (matches()) { data.loading = false; renderProjectNative(); } }
  }

  async function selectProjectNative(channelId = "") {
    if (!state.project || state.adminBusy || state.coordinationBusy || state.view === "project-native") return;
    stopNetwork(); clearError(); resetProjectNative("", state.channels.some(channel => channel.id === channelId) ? channelId : ""); setView("project-native"); await refresh();
  }

  async function changeProjectNativeFilter() {
    if (state.view !== "project-native" || !state.project) return;
    const actorId = $("project-native-actor").value, channelId = $("project-native-channel").value;
    if (actorId && !projectNativeAgents().some(agent => agent.id === actorId) || channelId && !state.channels.some(channel => channel.id === channelId)) return;
    stopNetwork(); resetProjectNative(actorId, channelId); clearError(); await refresh();
  }

  function renderNativeActivity() {
    const labels = {"session.started": tr("CLI session start reported"), "session.ended": tr("CLI session end reported"), "turn.started": tr("Turn start reported"), "turn.completed": tr("Turn completion reported"), "tool.started": tr("Tool start observed"), "tool.completed": tr("Tool completion observed"), "tool.failed": tr("Tool failure reported"), "agent.waiting": tr("Adapter reports waiting"), "inbox.offered": tr("Message offered to a CLI session"), "inbox.seen": tr("Session explicitly reported message viewed"), "inbox.accepted": tr("Session explicitly reported message acceptance")};
    const loaded = [...state.nativeActivity.values()].sort((a, b) => number(b.seq) - number(a.seq));
    const visible = loaded.filter(nativeEventVisible), hidden = loaded.length - visible.length;
    const rows = visible.map((event) => {
      const row = node("article", "native-activity-record"); row.dataset.nativeId = event.id; row.dataset.nativeType = event.event_type;
      appendOwned(row, () => (node("h3", "activity-title", () => (labels[event.event_type] || tr("Unknown client report type")))), () => (node("p", "native-provenance", () => (tr("Client-reported · not server-verified")))), () => (node("p", "activity-meta", () => (tr("{0} ({1}) · {2}\nStored {3} · seq {4}\nCLI session: {5} · channel: {6}", () => (displayName(event.actor_id)), () => (event.actor_id), () => (event.runtime), () => (dateText(event.created_at)), () => (event.seq), () => (event.session_id), () => (event.channel_id))))));
      if (event.tool_name) appendOwned(row, () => (node("p", "native-tool-name", () => (tr("Tool: {0}", () => (event.tool_name))))));
      if (event.message_id) appendOwned(row, () => (node("p", "activity-meta", () => (tr("Related message: {0}", () => (event.message_id))))));
      if (event.event_type === "turn.completed") appendOwned(row, () => (node("p", "native-boundary", () => (tr("Turn completion does not confirm task completion or passing checks.")))));
      if (event.event_type === "inbox.offered") appendOwned(row, () => (node("p", "native-boundary", () => (tr("Offered does not mean accepted by the model. Delivery and legacy receipts are tracked separately.")))));
      if (event.event_type === "inbox.seen") appendOwned(row, () => (node("p", "native-boundary", () => (tr("Viewed does not mean accepted or completed; legacy receipts are unchanged.")))));
      if (event.event_type === "inbox.accepted") appendOwned(row, () => (node("p", "native-boundary", () => (tr("Attributed acceptance report, not a legacy receipt or proof of completion.")))));
      return row;
    });
    if (!rows.length) rows.push(node("p", "empty-state", () => (hidden ? tr("Only technical events are loaded. Turn on “Show technical events” to view them.") : state.nativeReady ? tr("No CLI reports in this channel’s loaded window.") : tr("Reading activity for the selected channel…"))));
    replaceContent("native-activity-list", ...rows);
    setText($("native-activity-scope"), () => (state.channel ? tr("Only #{0} ({1}). Authorship is determined by the sender’s personal key.", () => (state.channel.name), () => (state.channel.id)) : tr("No channel selected.")));
    setText($("native-history-notice"), () => (tr("{0} reports loaded; {1} visible. {2}Up to 200 most recently loaded reports are retained. {3}The cursor also includes messages and receipts; it is not a completed-task count.", () => (loaded.length), () => (visible.length), () => (state.nativeWindowAfter > 0 ? tr("The initial window covers the last 200 channel cursor steps, not the entire archive. ") : ""), () => (state.nativeMore ? tr("Reading the next page… ") : ""))));
    renderTechnicalNotice("native-technical-notice", hidden);
  }

  async function nativeActivitySnapshot(context, channelId) {
    const after = state.nativeReady ? state.nativeSeq : Math.max(0, number(state.channel?.latest_seq) - 200);
    const response = await api(`/v1/channels/${pathId(channelId)}/activity?after_seq=${after}&limit=100`);
    if (!current(context) || state.channel?.id !== channelId) return false;
    if (!Array.isArray(response.activity) || typeof response.has_more !== "boolean" || !Number.isSafeInteger(response.next_after_seq) || response.next_after_seq < after) throw new ApiError(502, tr("The API returned an invalid CLI activity snapshot."));
    if (!state.nativeReady) state.nativeWindowAfter = after;
    for (const item of response.activity) {
      if (item.channel_id !== channelId || item.provenance !== "client_reported" || item.server_verified !== false || number(item.seq) <= after) throw new ApiError(502, tr("The API returned an incorrect CLI activity scope or attribution."));
      state.nativeActivity.set(item.id, item);
    }
    while (state.nativeActivity.size > 200) {
      const oldest = [...state.nativeActivity.values()].reduce((a, b) => number(a.seq) < number(b.seq) ? a : b);
      state.nativeActivity.delete(oldest.id);
    }
    state.nativeSeq = response.next_after_seq; state.nativeReady = true; state.nativeMore = response.has_more;
    renderNativeActivity(); return state.nativeMore;
  }

  function updatePermissions() {
    const archived = isOwner() && Boolean(state.project?.archived_at) && state.view !== "admin";
    $("archived-project-notice").hidden = !archived;
    setText($("archived-project-notice"), () => (archived ? tr("Archived project “{0}” ({1}). History is available only to the owner, read-only. Return to Administration to restore it.", () => (state.project.name), () => (state.project.id)) : ""));
    $("composer-form").hidden = !canMessage();
    $("viewer-caption").hidden = canMessage();
    setText($("viewer-caption"), () => (isWriter() ? tr("Writing is unavailable for this channel, or permissions are still being checked.") : tr("Read-only mode. Agents send messages using their own keys.")));
    $("new-note-button").hidden = !canNote();
    for (const control of $("composer-form").querySelectorAll("input,textarea,select,button,fieldset")) control.disabled = !canMessage() || state.sending;
    for (const control of $("note-form").querySelectorAll("input,textarea,button")) control.disabled = !canNote() || state.publishing;
    setText($("send-button"), () => (state.sending ? tr("Saving…") : state.pendingMessage ? tr("Retry the same request ↑") : $("channel-only").checked ? tr("Publish to channel ↑") : tr("Send ↑")));
    setText($("note-submit"), () => (state.publishing ? tr("Publishing…") : state.pendingNote ? tr("Retry the same request") : tr("Publish to project")));
    setText($("composer-identity"), () => (state.me ? tr("Acting as: {0} ({1}). Another sender cannot be selected.", () => (state.me.name), () => (state.me.id)) : ""));
    syncComposerAddressing();
  }

  function setView(view) {
    if (view === "admin" && !isOwner()) return;
    if (state.view === "admin" && view !== "admin") { clearAdminKey(); clearAdminDelete(); }
    const previousView = state.view;
    if (previousView === "overview" && view !== "overview") clearOverview();
    if (previousView === "project-native" && view !== "project-native") clearProjectNative();
    if (previousView === "project-map" && view !== "project-map") clearProjectMap();
    state.view = view;
    $("admin-panel").hidden = view !== "admin" || !isOwner();
    $("ordinary-workbench").hidden = ["admin", "overview", "project-native", "project-map"].includes(view) || isCoordination(view);
    $("overview-panel").hidden = view !== "overview";
    $("project-native-panel").hidden = view !== "project-native";
    $("project-map-panel").hidden = view !== "project-map";
    $("coordination-panel").hidden = !isCoordination(view);
    for (const name of Object.keys(COORDINATION_VIEWS)) $(`${name}-pane`).hidden = view !== name;
    if (isCoordination(view)) renderCoordination();
    const notes = view === "notes";
    $("channel-toolbar").hidden = notes || !state.channel;
    $("chat-panel").hidden = notes || view !== "chat" || !state.channel;
    $("activity-panel").hidden = notes || view !== "activity" || !state.channel;
    $("native-panel").hidden = view !== "native" || !state.channel;
    $("notes-panel").hidden = !notes || !state.project;
    $("empty-panel").hidden = Boolean(state.project && (notes || state.channel));
    setText($("channel-symbol"), () => (notes ? "◇" : "#"));
    setText($("current-channel"), () => (notes ? tr("Project notes") : state.channel?.name || tr("No selected channel")));
    setText($("channel-description"), () => (notes ? tr("Published for the entire project “{0}”", () => (state.project?.name || "")) : state.channel ? tr("Channel {0} · permitted messages and events only", () => (state.channel.id)) : tr("Select an available channel or project notes.")));
    setText($("channel-feed-name"), () => (state.channel ? `#${state.channel.name}` : ""));
    for (const tab of ["chat", "activity", "native"]) {
      $(`tab-${tab}`).setAttribute("aria-selected", String(view === tab));
      $(`tab-${tab}`).tabIndex = view === tab ? 0 : -1;
    }
    $("search-input").disabled = view !== "chat";
    renderNavigation(); updatePermissions();
    if (view === "chat") scheduleChannelRead();
    if (view === "native") { renderNativeActivity(); if (previousView !== "native") scheduleRefresh(); }
    if (view === "project-native") renderProjectNative();
    if (view === "project-map") renderProjectMap();
  }

  async function projectSnapshot(context) {
    const projectId = state.project.id;
    const [agents, notes] = await Promise.all([
      api(`/v1/projects/${pathId(projectId)}/agents`), api(`/v1/projects/${pathId(projectId)}/notes`),
    ]);
    if (!current(context)) return;
    state.agents = list(agents.agents); state.notes = list(notes.notes); state.notesTruncated = notes.truncated === true;
    syncProjectNativeScope();
    renderAgents(); renderRecipients(); renderNotes();
  }

  async function selectProject(project, initialView = "overview") {
    if (state.adminBusy || (project.archived_at && !isOwner())) return;
    setText($("workspace-notice"), () => ("")); $("workspace-notice").hidden = true;
    stopNetwork(); clearDrafts(); clearCoordination(); clearNativeActivity(); clearOverview(); clearProjectNative(); clearProjectMap(); clearError();
    state.project = project; state.channel = null; state.channels = []; state.agents = []; state.notes = []; state.notesTruncated = false;
    state.messages.clear(); state.events.clear(); state.messageSeq = 0; state.dataReady = false; state.projectReady = false; state.loading = true;
    const context = state.context;
    setView(initialView); renderAgents(); renderNotes(); renderMessages(); renderEvents();
    connection(tr("Checking project access…"));
    await refresh(context);
  }

  async function selectChannel(channel) {
    if (state.adminBusy) return;
    if ((isCoordination() || ["overview", "project-native", "project-map"].includes(state.view)) && state.channel?.id === channel.id) { stopNetwork(); setView("chat"); await refresh(); return; }
    stopNetwork(); clearDrafts(); clearNativeActivity(); clearError();
    state.channel = channel; state.messages.clear(); state.events.clear(); state.messageSeq = 0;
    state.loading = true; state.dataReady = false;
    const context = state.context;
    setView("chat"); renderMessages(); renderEvents(); renderRecipients();
    connection(tr("Loading channel…"));
    await refresh(context);
  }

  async function selectNotes() {
    if (!state.project || state.adminBusy) return;
    stopNetwork(); clearDrafts(); clearNativeActivity(); clearError();
    state.channel = null; state.messages.clear(); state.events.clear(); state.messageSeq = 0;
    state.dataReady = false; state.loading = true;
    setView("notes"); renderMessages(); renderEvents();
    connection(tr("Loading project notes…"));
    const context = state.context;
    await refresh(context);
  }

  function clearChannelContent() {
    clearNativeReceipts();
    clearNativeActivity();
    if (state.channel) { state.cursors.delete(state.channel.id); state.channelUpdates.delete(state.channel.id); }
    state.channel = null; state.messages.clear(); state.events.clear(); state.messageSeq = 0;
    state.pendingMessage = null; state.sending = false; state.replyRecipient = "";
    $("composer-form").reset(); setText($("send-status"), () => ("")); $("search-input").value = "";
    $("history-notice").hidden = true;
    renderMessages(); renderEvents(); renderRecipients(); validateFields();
  }

  async function reconcileWorkspace(context) {
    const [projects] = await Promise.all([api("/v1/projects"), loadNavigation(context)]);
    if (!current(context)) return false;
    state.projects = list(projects.projects);
    let selected = state.project && state.projects.find((project) => project.id === state.project.id);
    // Owners retain read-only access to archived history, absent from active navigation.
    if (isOwner() && state.project && !selected) {
      const overview = state.view === "admin" && state.admin ? state.admin : await api("/v1/admin/overview");
      if (!current(context)) return false;
      selected = list(overview.projects).find((project) => project.id === state.project.id);
    }
    if (state.project && !selected) {
      state.accessRecheckUntil = Date.now() + 30000;
      forgetProjectContent(state.project.id);
      if (state.view !== "admin") {
        state.view = state.projects.length ? "overview" : "chat";
        setText($("workspace-notice"), () => (state.projects.length ? tr("The selected project is no longer available. Another available project’s overview was opened; check its name before continuing.") : tr("The selected project is no longer available. Its data has been cleared; new permissions will appear automatically.")));
        $("workspace-notice").hidden = false;
      }
    }
    state.project = selected || state.project || state.projects[0] || null;
    if (!state.project) {
      state.channels = []; state.loading = false; state.dataReady = true; state.projectReady = true;
      if (state.view !== "admin") setView("chat");
      setText($("empty-panel"), () => (tr("No available projects. New projects and granted access will appear automatically.")));
      renderNavigation(); return true;
    }
    const channels = await api(`/v1/projects/${pathId(state.project.id)}/channels`);
    if (!current(context)) return false;
    const incoming = list(channels.channels), visibleIds = new Set(incoming.map((channel) => channel.id));
    if (state.overview) state.overview.sessions = state.overview.sessions.filter((session) => visibleIds.has(session.channel_id));
    for (const old of state.channels) if (!visibleIds.has(old.id)) {
      state.accessRecheckUntil = Date.now() + 30000;
      state.cursors.delete(old.id); state.channelUpdates.delete(old.id); state.channelSeen.delete(old.id);
    }
    const previousChannel = state.channel;
    const selectedChannel = previousChannel && incoming.find((channel) => channel.id === previousChannel.id);
    state.channels = incoming;
    syncProjectNativeScope();
    syncProjectMapScope();
    if (previousChannel && !selectedChannel) clearChannelContent();
    else if (selectedChannel) state.channel = selectedChannel;
    if (!["notes", "admin", "overview", "project-native", "project-map"].includes(state.view) && !isCoordination() && !state.channel) state.channel = incoming[0] || null;
    for (const channel of incoming) {
      const latest = channelMessageSeq(channel);
      if (!state.channelSeen.has(channel.id)) state.channelSeen.set(channel.id, latest);
      else if (latest > state.channelSeen.get(channel.id) && (state.channel?.id !== channel.id || isCoordination() || ["overview", "project-native", "project-map"].includes(state.view))) state.channelUpdates.add(channel.id);
      if (state.channel?.id === channel.id && ["chat", "activity", "native"].includes(state.view)) {
        state.channelSeen.set(channel.id, latest); state.channelUpdates.delete(channel.id);
      }
    }
    if (!state.channel && !["admin", "overview", "project-native", "project-map"].includes(state.view) && !isCoordination()) state.view = "notes";
    state.projectReady = true;
    if (state.view !== "admin") setView(state.view);
    else renderNavigation();
    // Losing write access invalidates pending write actions, without discarding unrelated drafts.
    if (previousChannel?.can_write && selectedChannel?.can_write === false) {
      state.pendingMessage = null; state.replyRecipient = "";
      $("channel-only").checked = false;
      for (const input of $("recipient-list").querySelectorAll("input")) input.checked = false;
      syncComposerAddressing();
    }
    if (!isOwner() && !state.channels.some((channel) => channel.can_write === true) && $("note-dialog").open) {
      state.pendingNote = null; $("note-form").reset(); $("note-dialog").close(); validateFields();
    }
    return true;
  }

  async function channelSnapshot(context) {
    const channelId = state.channel.id;
    const cursor = state.cursors.get(channelId) || 0;
    const [messageData, eventData, nativeMore] = await Promise.all([
      api(`/v1/channels/${pathId(channelId)}/messages?after_seq=${state.messageSeq}&limit=${MESSAGES_PAGE}`),
      api(`/v1/channels/${pathId(channelId)}/events?after=${cursor}&limit=${EVENTS_PAGE}`),
      state.view === "native" ? nativeActivitySnapshot(context, channelId) : Promise.resolve(false),
    ]);
    if (!current(context)) return false;
    const incoming = list(messageData.messages).filter((message) => message.channel_id === channelId);
    const events = list(eventData.events).filter((event) => event.channel_id === channelId && number(event.seq) > cursor);
    for (const message of incoming) { state.messages.set(message.id, message); state.messageSeq = Math.max(state.messageSeq, number(message.seq)); }
    // Hints never carry trusted message data. Re-fetch each affected authorized message.
    const changed = [...new Set(events.filter((event) => event.kind !== "message.created" && state.messages.has(event.entity_id)).map((event) => event.entity_id))];
    for (let index = 0; index < changed.length; index += 4) {
      const snapshots = await Promise.all(changed.slice(index, index + 4).map((id) => api(`/v1/messages/${pathId(id)}`)));
      if (!current(context)) return false;
      for (const snapshot of snapshots) if (snapshot.message?.channel_id === channelId) state.messages.set(snapshot.message.id, snapshot.message);
    }
    if (!current(context)) return false;
    await loadNativeReceipts(context, channelId);
    if (!current(context) || state.channel?.id !== channelId) return false;
    for (const event of events) state.events.set(number(event.seq), event);
    while (state.events.size > 200) state.events.delete(Math.min(...state.events.keys()));
    // Advance only after REST replay and authorized snapshots succeed, never from SSE alone.
    const nextCursor = Math.max(cursor, ...events.map((event) => number(event.seq)));
    state.cursors.set(channelId, nextCursor);
    const more = incoming.length === MESSAGES_PAGE || events.length === EVENTS_PAGE || nativeMore;
    $("history-notice").hidden = !more;
    renderMessages(); renderEvents();
    return more;
  }

  function handleReadError(error, context) {
    if (!current(context)) return;
    state.loading = false;
    if (error.status === 403 || error.status === 404) {
      state.accessRecheckUntil = Date.now() + 30000;
      clearOverview();
      clearProjectNative();
      clearProjectMap();
      clearAdminKey(); clearAdminDelete();
      clearCoordination();
      clearNativeActivity();
      // Never leave previously authorized content on screen after access is denied.
      stopNetwork(); state.dataReady = false;
      state.messages.clear(); state.events.clear(); state.agents = []; state.notes = []; state.channels = []; state.notesTruncated = false;
      $("notes-truncated").hidden = true;
      state.channel = null; state.project = null; state.projects = []; state.cursors.clear();
      state.navigation = null;
      clearDrafts();
      for (const id of ["message-list", "activity-list", "agent-list", "memory-list", "recipient-list"]) $(id).replaceChildren();
      setView("chat"); renderNavigation(); updatePermissions();
      setText($("project-name"), () => (tr("Access unconfirmed")));
      setText($("empty-panel"), () => (tr("The server denied data access. See the reason above; an empty dataset has not been established.")));
      setText($("updated-at"), () => (""));
      connection(tr("Access to the selected data changed · checking the available workspace"), "reconnecting");
      scheduleRefresh();
    } else {
      if (state.view === "project-native" && state.projectNative) { state.projectNative.error = errorText(error); state.projectNative.loading = false; renderProjectNative(); }
      if (state.view === "project-map" && state.projectMap) { state.projectMap.error = errorText(error); state.projectMap.loading = false; renderProjectMap(); }
      renderAgents(); renderNotes(); renderMessages(); renderEvents(); renderNavigation();
      connection(state.dataReady ? tr("Refresh failed · showing the last received data") : tr("Data not received yet · retrying through fallback polling"), "reconnecting");
    }
    showError(error); updatePermissions();
  }

  async function refresh(context = state.context) {
    if (!current(context) || !state.me) return;
    if (state.adminBusy || state.coordinationBusy) { state.refreshAgain = true; return; }
    if (state.refreshing) { state.refreshAgain = true; return; }
    state.refreshing = true; state.lastRefresh = Date.now();
    if (!state.dataReady && state.view !== "admin") $("refresh-button").disabled = true;
    let more = false;
    try {
      if (state.view === "admin") {
        if (!await loadAdmin(Boolean(state.admin))) return;
        if (!current(context)) return;
        if (!await reconcileWorkspace(context)) return;
      } else {
        if (!await reconcileWorkspace(context) || !current(context)) return;
        if (state.project) {
          if (state.view === "project-map") {
            // Map mode never downloads note/message bodies or per-entity details.
            await projectMapSnapshot(context);
          } else {
            const results = await Promise.all([projectSnapshot(context), !isCoordination() && !["overview", "project-native"].includes(state.view) && state.channel ? channelSnapshot(context) : Promise.resolve(false), isCoordination() ? coordinationSnapshot(context) : state.view === "overview" ? overviewSnapshot(context) : Promise.resolve()]);
            if (current(context) && state.view === "project-native") await projectNativeSnapshot(context);
            more = results[1];
          }
        }
      }
      if (!current(context)) return;
      state.loading = false; state.dataReady = true;
      clearError(); updatePermissions(); renderRecipients(); renderMessages(); renderNotes(); renderEvents(); renderAgents(); renderNavigation();
      state.lastSync = Date.now(); state.syncError = false; renderConnection(); renderOverview();
    } catch (error) { if (current(context)) { state.syncError = true; handleReadError(error, context); renderOverview(); } }
    finally {
      if (current(context)) {
        state.refreshing = false; $("refresh-button").disabled = false;
        if (more || state.refreshAgain) { state.refreshAgain = false; scheduleRefresh(); }
      }
    }
  }

  function scheduleRefresh() {
    if (!state.key || !state.me) return;
    if (state.refreshing) { state.refreshAgain = true; return; }
    if (state.refreshTimer) return;
    const authVersion = state.authVersion;
    const wait = Math.max(150, REFRESH_MIN_MS - (Date.now() - state.lastRefresh));
    state.refreshTimer = setTimeout(() => { state.refreshTimer = null; if (currentAuth(authVersion)) void refresh(); }, wait);
  }

  function startPolling() {
    clearTimeout(state.pollTimer);
    const authVersion = state.authVersion;
    const tick = () => {
      if (!currentAuth(authVersion)) return;
      renderProjectNativeFreshness();
      // ACL may be revoked and restored between sampled SSE revisions (A→B→A).
      // After observing a loss, use the existing eight-second fallback briefly
      // even with a healthy stream; never keep removed data while waiting.
      if (!state.streamConnected || Date.now() < state.accessRecheckUntil || Date.now() - state.lastSync > 25000) scheduleRefresh();
      state.pollTimer = setTimeout(tick, POLL_MS);
    };
    state.pollTimer = setTimeout(tick, POLL_MS);
  }

  function onSseBlock(block, authVersion) {
    if (!currentAuth(authVersion)) return;
    let type = "message", data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") type = value;
      else if (field === "data") data += value + "\n";
    }
    if (type !== "workspace" || !data) return;
    let pointer;
    try { pointer = JSON.parse(data); } catch { return; }
    if (typeof pointer.revision !== "string" || !/^[a-f0-9]{64}$/i.test(pointer.revision)) return;
    if (pointer.revision === state.workspaceRevision) return;
    state.workspaceRevision = pointer.revision;
    scheduleRefresh();
  }

  async function startStream(authVersion = state.authVersion) {
    if (!currentAuth(authVersion) || !state.me || state.stream) return;
    const controller = new AbortController(); state.stream = controller;
    let reader;
    const watch = () => {
      clearTimeout(state.streamWatchdog);
      state.streamWatchdog = setTimeout(() => controller.abort(), 25000);
    };
    try {
      watch();
      const response = await fetch("/v1/workspace/stream", {
        headers: {Authorization: `Bearer ${state.key}`, Accept: "text/event-stream"},
        signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      });
      if (!currentAuth(authVersion)) return;
      if (response.status === 401) { lock(tr("The key is revoked or invalid. Data and the key have been cleared from this tab.")); return; }
      if (response.status === 403) { lock(tr("Access to the workspace stream was denied. Connect with a valid personal key.")); return; }
      if (!response.ok || !response.body || !response.headers.get("Content-Type")?.includes("text/event-stream")) throw new Error("Stream unavailable");
      state.streamConnected = true; state.retry = 0;
      // A revision is only a wakeup hint. Every connection gets an independent REST catch-up.
      state.workspaceRevision = ""; scheduleRefresh(); renderConnection();
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (currentAuth(authVersion)) {
        const result = await reader.read();
        if (!currentAuth(authVersion) || state.stream !== controller) return;
        if (result.done) break;
        watch();
        buffer += decoder.decode(result.value, {stream: true});
        // CRLF may be split across chunks. Normalize after concatenation.
        buffer = buffer.replace(/\r\n/g, "\n");
        if (buffer.length > 65536) throw new Error("Oversized stream block");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          onSseBlock(buffer.slice(0, boundary), authVersion);
          buffer = buffer.slice(boundary + 2);
        }
      }
    } catch { /* REST fallback remains active; no hint is treated as a snapshot. */ }
    finally {
      if (reader) { try { await reader.cancel(); } catch { /* Stream already closed. */ } }
      controller.abort();
      if (currentAuth(authVersion) && state.stream === controller) {
        clearTimeout(state.streamWatchdog); state.streamWatchdog = null;
        state.stream = null; state.streamConnected = false;
        const seconds = Math.min(8, 2 ** Math.min(state.retry, 3)); state.retry += 1;
        renderConnection();
        state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; void startStream(authVersion); }, seconds * 1000);
        scheduleRefresh();
      }
    }
  }

  function clientId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return "web-" + [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  function pendingPayload(previous, payload) {
    const signature = JSON.stringify(payload);
    return previous?.signature === signature ? previous : {signature, body: {...payload, client_id: clientId()}};
  }

  async function sendMessage(event) {
    event.preventDefault();
    validateFields();
    if (!canMessage() || state.sending || !$("composer-form").reportValidity()) return;
    const body = $("message-input").value.trim(); if (!body) return;
    const channelOnly = $("channel-only").checked;
    const payload = {body, recipient_ids: channelOnly ? [] : selectedRecipients()};
    if (!channelOnly && !payload.recipient_ids.length) {
      setText($("send-status"), () => tr("Choose a recipient, or explicitly publish to the channel only.")); return;
    }
    if ($("recipient-list").dataset.scope !== recipientScope() || payload.recipient_ids.some(id => !availableRecipients().some(agent => agent.id === id))) {
      setText($("send-status"), () => tr("Recipient access changed. Choose recipients again.")); return;
    }
    if (payload.recipient_ids.length > 32) { setText($("send-status"), () => (tr("No more than 32 recipients are allowed."))); return; }
    if (channelOnly) payload.channel_only = true;
    if ($("reply-to").value) {
      const reply = state.messages.get($("reply-to").value);
      if (!reply || reply.channel_id !== state.channel.id) { setText($("send-status"), () => tr("The reply target is no longer available in this channel.")); return; }
      payload.reply_to = reply.id;
    }
    state.pendingMessage = pendingPayload(state.pendingMessage, payload);
    const context = state.context, channelId = state.channel.id;
    state.sending = true; setText($("send-status"), () => (tr("Waiting for server confirmation of storage…"))); updatePermissions();
    try {
      const result = await api(`/v1/channels/${pathId(channelId)}/messages`, {method: "POST", body: state.pendingMessage.body});
      if (!current(context) || state.channel?.id !== channelId) return;
      if (!result.message || result.message.channel_id !== channelId) throw new Error("Invalid message response");
      state.messages.set(result.message.id, result.message);
      // Do not move the history cursor: an own message can arrive ahead of unseen history.
      state.pendingMessage = null; state.replyRecipient = ""; $("composer-form").reset(); validateFields();
      setText($("send-status"), () => joinText([
        ...(result.replayed ? [tr("The server confirmed the previously stored message. No new copy was created.")] : []),
        channelOnly ? tr("Published to the channel only. This message will not enter any agent’s native inbox.") : tr("Stored for the selected recipients. This does not confirm viewing or acceptance."),
      ], " "));
      clearError(); renderMessages(); scheduleRefresh();
    } catch (error) {
      if (!current(context) || state.channel?.id !== channelId) return;
      setText($("send-status"), () => (error instanceof ApiError && error.status < 500 ? errorText(error) : tr("Storage outcome is unknown. Retry the unchanged request: the same client_id prevents a second record but does not prove model execution.")));
      if (error instanceof ApiError && error.status < 500) state.pendingMessage = null;
      showError(error);
    } finally { if (current(context) && state.channel?.id === channelId) { state.sending = false; updatePermissions(); renderMessages(); } }
  }

  async function publishNote(event) {
    event.preventDefault();
    validateFields();
    if (!canNote() || state.publishing || !$("note-form").reportValidity()) return;
    const title = $("note-title").value.trim(), body = $("note-body").value.trim();
    if (!title || !body) return;
    const payload = {title, body};
    const source = $("note-source").value.trim(); if (source) payload.source_message_id = source;
    state.pendingNote = pendingPayload(state.pendingNote, payload);
    const context = state.context, projectId = state.project.id;
    state.publishing = true; setText($("note-status"), () => (tr("Waiting for publication confirmation…"))); updatePermissions();
    try {
      const result = await api(`/v1/projects/${pathId(projectId)}/notes`, {method: "POST", body: state.pendingNote.body});
      if (!current(context) || state.project?.id !== projectId) return;
      if (!result.note || result.note.project_id !== projectId) throw new Error("Invalid note response");
      state.notes = [result.note, ...state.notes.filter((note) => note.id !== result.note.id)];
      state.pendingNote = null; $("note-form").reset(); validateFields(); setText($("note-status"), () => ("")); $("note-dialog").close();
      clearError(); renderNotes(); scheduleRefresh();
    } catch (error) {
      if (!current(context) || state.project?.id !== projectId) return;
      setText($("note-status"), () => (error instanceof ApiError && error.status < 500 ? errorText(error) : tr("Publication outcome is unknown. Retry without changing the fields: the same client_id will not create a second note.")));
      if (error instanceof ApiError && error.status < 500) state.pendingNote = null;
    } finally { if (current(context) && state.project?.id === projectId) { state.publishing = false; updatePermissions(); } }
  }

  // Coordination is project-scoped published data, never a process controller.
  // Drafts stay outside snapshot rendering. Versions are captured explicitly,
  // so a background refresh cannot silently rebase an in-progress mutation.
  const TASK_STATES = {ready: tr("Ready for work"), running: tr("Work reported"), artifacts_ready: tr("Artifacts submitted"), review_pending: tr("Awaiting review"), approved: tr("Approved by reviewer"), changes_requested: tr("Reviewer requested changes"), completion_reported: tr("Assignee reported completion"), uncertain: tr("Uncertain · decision required"), cancelled: tr("Cancellation recorded")};
  const TASK_EVENTS = {run_started: tr("Declare a new task run"), artifacts_ready: tr("Submit the full artifact set"), review_requested: tr("Request review of the set"), review_result: tr("Publish reviewer decision"), verification_reported: tr("Publish an external verification report"), completion_reported: tr("Report completion"), uncertain: tr("Record uncertainty"), recovery_decided: tr("Record a recovery decision"), cancelled: tr("Record cancellation")};
  const ARTIFACT_ROLES = {baseline: tr("Baseline"), implementation: tr("Implementation"), test: tr("Test"), evidence: tr("Evidence / report"), bundle: tr("Bundle"), document: tr("Document")};
  const artifactEvents = new Set(["artifacts_ready", "review_requested", "review_result", "verification_reported", "completion_reported"]);
  function newCoordination() {
    return {projectId: state.project?.id, tasks: [], taskId: "", task: null, taskWritable: false, tasksTruncated: false,
      memory: [], memoryId: "", memoryDetail: null, memoryWritable: false, memoryTruncated: false, memoryDraft: null, memoryRefs: new Map(),
      artifacts: [], artifactsMore: false, artifactAfter: 0, sessions: [], sessionsTruncated: false,
      ready: new Set(), eventDraft: null, pending: new Map(), fullTimeline: null, historyAfter: 0, historyMore: false, mapTaskTarget: "", mapMemoryTarget: ""};
  }
  function clearCoordination() {
    state.coordinationEpoch += 1; state.coordinationBusy = false; state.coordination = null;
    for (const url of state.downloads) URL.revokeObjectURL(url);
    state.downloads.clear();
    for (const id of ["task-list", "task-detail", "task-timeline", "project-memory-list", "project-memory-detail", "memory-history", "memory-selected-list", "memory-selected-refs", "memory-selected-status", "artifact-list", "session-list", "task-agent-options"]) $(id).replaceChildren();
    for (const id of ["task-create-form", "task-event-form", "memory-form", "artifact-form"]) $(id).reset();
    $("memory-form").hidden = true; $("task-event-form").hidden = true;
    $("task-create-section").open = false; $("artifact-upload-section").open = false;
    setText($("coordination-status"), () => ("")); setText($("coordination-scope"), () => ("")); setText($("coordination-access"), () => (""));
    clearError("coordination-error");
  }
  function coordinationData() {
    if (!state.coordination || state.coordination.projectId !== state.project?.id) state.coordination = newCoordination();
    return state.coordination;
  }
  function coordinationWritable(kind = state.view) {
    const data = state.coordination;
    return Boolean(isWriter() && state.project && !state.project.archived_at && data?.projectId === state.project.id &&
      (kind === "memory" ? data.memoryWritable : data.taskWritable));
  }
  function coordinationRoute(suffix) { return `/v1/projects/${pathId(state.project.id)}/${suffix}`; }
  async function selectCoordination(view) {
    if (!isCoordination(view) || !state.project || state.adminBusy || state.coordinationBusy) return;
    if (state.view === view) return;
    stopNetwork(); clearError(); coordinationData(); setView(view);
    await refresh();
  }
  function scopeMatches(context, projectId, epoch) {
    return current(context) && state.project?.id === projectId && epoch === state.coordinationEpoch;
  }
  async function coordinationSnapshot(context) {
    const data = coordinationData(), projectId = state.project.id, view = state.view, epoch = state.coordinationEpoch;
    const base = `/v1/projects/${pathId(projectId)}`;
    let response, detail;
    if (view === "tasks") {
      response = await api(`${base}/tasks`);
      // An explicit map destination may be outside the list's 1000-row window.
      const selected = list(response.tasks).find((task) => task.id === data.taskId) || (data.mapTaskTarget === data.taskId && data.taskId ? {id: data.taskId} : list(response.tasks)[0]);
      if (selected) detail = await api(`${base}/tasks/${pathId(selected.id)}`);
      if (!scopeMatches(context, projectId, epoch)) return;
      data.tasks = list(response.tasks).filter((task) => task.project_id === projectId); data.tasksTruncated = response.truncated === true;
      const priorWritable = data.taskWritable;
      data.taskWritable = response.can_write === true && (!detail || detail.can_write === true);
      if (detail?.task?.project_id !== projectId) detail = null;
      if (data.taskId !== (detail?.task?.id || "")) { data.eventDraft = null; data.fullTimeline = null; $("task-event-form").reset(); }
      data.taskId = detail?.task?.id || ""; data.task = detail || null;
      if (data.fullTimeline && detail) {
        const events = new Map(data.fullTimeline.map((entry) => [entry.version, entry]));
        for (const entry of list(detail.events)) events.set(entry.version, entry);
        data.fullTimeline = [...events.values()].sort((a, b) => a.version - b.version);
      }
      if (priorWritable && !data.taskWritable) { data.eventDraft = null; data.pending.clear(); $("task-event-form").reset(); $("task-create-form").reset(); }
    } else if (view === "memory") {
      response = await api(`${base}/memory`);
      const selected = list(response.memory).find((entry) => entry.id === data.memoryId) || (data.mapMemoryTarget === data.memoryId && data.memoryId ? {id: data.memoryId} : list(response.memory)[0]);
      if (selected) detail = await api(`${base}/memory/${pathId(selected.id)}`);
      if (!scopeMatches(context, projectId, epoch)) return;
      data.memory = list(response.memory).filter((entry) => entry.project_id === projectId); data.memoryTruncated = response.truncated === true;
      const priorWritable = data.memoryWritable;
      data.memoryWritable = response.can_write === true && (!detail || detail.can_write === true);
      if (detail?.memory?.project_id !== projectId) detail = null;
      data.memoryId = detail?.memory?.id || ""; data.memoryDetail = detail || null;
      if (priorWritable && !data.memoryWritable) closeMemoryDraft();
    } else if (view === "sessions") {
      response = await api(`${base}/sessions`);
      if (!scopeMatches(context, projectId, epoch)) return;
      data.sessions = list(response.sessions).filter((session) => session.project_id === projectId);
      data.sessionsTruncated = response.truncated === true;
    } else if (view === "artifacts") {
      // A project capability is authoritative; channel write access is not substituted.
      const [artifacts, capability] = await Promise.all([api(`${base}/artifacts?after_seq=${data.artifactAfter}&limit=100`), api(`${base}/tasks`)]);
      if (!scopeMatches(context, projectId, epoch)) return;
      const byId = new Map(data.artifacts.map((item) => [item.id, item]));
      for (const artifact of list(artifacts.artifacts)) if (artifact.project_id === projectId) byId.set(artifact.id, artifact);
      data.artifacts = [...byId.values()].sort((a, b) => number(a.seq) - number(b.seq));
      data.artifactsMore = artifacts.has_more === true;
      // Keep re-reading the newest page, while older pages remain immutable in memory.
      if (!data.artifactsMore) data.artifactAfter = Math.max(data.artifactAfter, ...data.artifacts.map((item) => number(item.seq)));
      data.taskWritable = capability.can_write === true;
      if (!data.taskWritable) { data.pending.delete("artifact"); $("artifact-form").reset(); }
    }
    if (!scopeMatches(context, projectId, epoch) || state.view !== view) return;
    data.ready.add(view); renderCoordination();
  }
  function record(title, text, meta) {
    const article = node("article", "coordination-record");
    appendOwned(article, () => (node("h4", "", () => (title))));
    if (text) appendOwned(article, () => (node("p", "coordination-body", () => (text))));
    if (meta) appendOwned(article, () => (node("p", "coordination-meta", () => (meta))));
    return article;
  }
  function statusTag(value, label) { const tag = node("span", "coordination-state", () => (label || value)); tag.dataset.state = value; return tag; }
  function artifactLabel(ref) { return formatText([""," · ","\nID ","\nSHA-256 ",""], () => (ARTIFACT_ROLES[ref.role] || ref.role), () => (ref.role), () => (ref.artifact_id || ref.id), () => (ref.sha256)); }
  function appendRefs(container, refs) { for (const ref of list(refs)) appendOwned(container, () => (node("p", "coordination-artifact", () => (artifactLabel(ref))))); }
  function renderCoordination() {
    if (!isCoordination() || !state.project) return;
    const data = coordinationData();
    setText($("coordination-title"), () => (COORDINATION_VIEWS[state.view]));
    setText($("coordination-scope"), () => (tr("Project “{0}” ({1}){2}. Only data permitted for this account.", () => (state.project.name), () => (state.project.id), () => (state.project.archived_at ? tr(" · archived, read-only") : ""))));
    setText($("coordination-access"), () => (state.view === "sessions" ? tr("Sessions: read-only. No process controls.") : coordinationWritable() ? tr("Publishing as {0}. The server independently checks permissions and versions.", () => (state.me.id)) : tr("Read-only, or permissions are not confirmed yet. The owner does not act on behalf of agents.")));
    if (state.view === "tasks") renderTasks(data);
    if (state.view === "memory") renderMemory(data);
    if (state.view === "sessions") renderSessions(data);
    if (state.view === "artifacts") renderArtifacts(data);
    updateCoordinationControls();
  }
  function renderTasks(data) {
    const cards = data.tasks.map((task) => {
      const card = record(task.title, "", tr("Assignee: {0} ({1})\nReviewer: {2} ({3})\nID {4} · version {5}", () => (displayName(task.owner_id)), () => (task.owner_id), () => (displayName(task.reviewer_id)), () => (task.reviewer_id), () => (task.id), () => (task.version)));
      card.dataset.taskId = task.id; appendOwned(card, () => (statusTag(task.state, TASK_STATES[task.state])));
      const button = node("button", "text-button", () => (tr("Open task"))); button.type = "button";
      button.dataset.focusKey = `task:${task.id}`; button.setAttribute("aria-pressed", String(task.id === data.taskId));
      button.addEventListener("click", () => selectTask(task.id)); appendOwned(card, () => (button)); return card;
    });
    if (!cards.length) cards.push(node("p", "empty-state", () => (data.ready.has("tasks") ? tr("No tasks in this project.") : tr("Reading tasks…"))));
    if (data.tasksTruncated) cards.push(node("p", "field-help", () => (tr("Showing the latest 1,000 tasks."))));
    replaceContent("task-list", ...cards);
    replaceContent("task-agent-options", ...state.agents.filter((agent) => agent.kind === "agent").map((agent) => { const option = node("option", "", () => (agent.name)); option.value = agent.id; return option; }));
    const detail = data.task, task = detail?.task;
    if (!task) { replaceContent("task-detail", node("p", "empty-state", () => (tr("Select a task to view its roles, artifact set, and timeline.")))); replaceContent("task-timeline"); return; }
    const content = record(task.title, "", tr("ID {0} · version {1}\nAssignee {2} · independent reviewer {3}\nCurrent run: {4}\nUpdated: {5}", () => (task.id), () => (task.version), () => (task.owner_id), () => (task.reviewer_id), () => (task.current_run_id || tr("not started")), () => (dateText(task.updated_at))));
    content.dataset.taskId = task.id; content.dataset.version = task.version;
    appendOwned(content, () => (statusTag(task.state, TASK_STATES[task.state])));
    for (const [label, values] of [[tr("Scope of work"), task.scope], [tr("Acceptance criteria"), task.acceptance]]) {
      appendOwned(content, () => (node("h4", "", () => (label)))); const items = node("ul");
      for (const value of list(values)) appendOwned(items, () => (node("li", "", () => (value)))); appendOwned(content, () => (items));
    }
    const run = currentTaskRun(data);
    if (run) {
      appendOwned(content, () => (node("p", "coordination-meta", () => (tr("External verification report: {0}. The server did not run tests.\nReview request: {1}", () => (run.verification_status || tr("none")), () => (run.review_request_id || tr("none")))))));
      appendRefs(content, run.artifacts);
    }
    replaceContent("task-detail", content);
    const events = data.fullTimeline || list(detail.events);
    const rows = events.map((event) => {
      const row = record(TASK_EVENTS[event.type] || event.type, event.summary, tr("Report author {0} · {1}\nVersion {2} · run {3}\nEvent {4}", () => (event.actor_id), () => (dateText(event.created_at)), () => (event.version), () => (event.run_id), () => (event.id)));
      row.dataset.eventType = event.type; row.dataset.eventId = event.id;
      if (event.type === "completion_reported") appendOwned(row, () => (node("p", "", () => (tr("Assignee’s completion claim, not server-verified success.")))));
      if (event.type === "review_result") appendOwned(row, () => (node("p", "", () => (tr("Report from the assigned independent reviewer: {0}. Not server verification.", () => (event.verdict === "approved" ? tr("approved") : tr("changes required")))))));
      if (event.review_request_id) appendOwned(row, () => (node("p", "coordination-meta", () => (tr("Related review request: {0}", () => (event.review_request_id))))));
      if (event.evidence) {
        appendOwned(row, () => (node("p", "", () => (tr("External verification report: {0}. Reported by the {1}, not the server.", () => (event.evidence.status), () => (event.actor_id === task.reviewer_id ? tr("independent reviewer") : tr("assignee")))))), () => (node("pre", "coordination-body", () => (tr("Reported command: {0}\nReported exit_code: {1}", () => (event.evidence.command), () => (event.evidence.exit_code ?? tr("not specified")))))));
        if (event.evidence.artifact) appendRefs(row, [event.evidence.artifact]);
      }
      if (event.recovery_action) appendOwned(row, () => (node("p", "", () => (tr("Decision: {0}. External processes are not started or stopped.", () => (event.recovery_action))))));
      appendRefs(row, event.artifacts); return row;
    });
    if (!rows.length) rows.push(node("p", "empty-state", () => (tr("No events have been published yet. Creating a task does not start work by itself."))));
    if (detail.events_truncated && !data.fullTimeline) rows.unshift(node("p", "field-help", () => (tr("Showing the latest 200 events. Earlier events remain on the server."))));
    if (data.fullTimeline && data.historyMore) rows.unshift(node("p", "field-help", () => (tr("History is not fully loaded. Continue paging; fresh events are shown separately from the history gap."))));
    replaceContent("task-timeline", ...rows);
    $("task-timeline-all").hidden = data.fullTimeline ? !data.historyMore : !detail.events_truncated;
    setText($("task-timeline-all"), () => (data.fullTimeline ? tr("Next history events") : tr("Load history from the beginning")));
  }
  function currentTaskRun(data = state.coordination) { return list(data?.task?.runs).find((run) => run.id === data?.task?.task?.current_run_id); }
  function taskActions() {
    const task = state.coordination?.task?.task;
    if (!task || !coordinationWritable("tasks")) return [];
    const own = task.owner_id === state.me.id, review = task.reviewer_id === state.me.id, active = task.current_run_id && !["completion_reported", "cancelled"].includes(task.state);
    const choices = [];
    if (own && ["ready", "completion_reported", "cancelled"].includes(task.state)) choices.push("run_started");
    if (own && ["running", "artifacts_ready", "changes_requested", "approved", "review_pending"].includes(task.state)) choices.push("artifacts_ready");
    if (own && task.state === "artifacts_ready") choices.push("review_requested");
    if (review && task.state === "review_pending") choices.push("review_result");
    if ((own || review) && ["artifacts_ready", "review_pending", "approved", "changes_requested"].includes(task.state)) choices.push("verification_reported");
    if (own && task.state === "approved" && currentTaskRun()?.verification_status === "passed") choices.push("completion_reported");
    if ((own || review) && active) choices.push("uncertain");
    if (own && task.state === "uncertain") choices.push("recovery_decided");
    if (own && active) choices.push("cancelled");
    return choices;
  }
  function updateCoordinationControls() {
    if (!state.coordination) return;
    const data = state.coordination, busy = state.coordinationBusy;
    for (const [form, allowed] of [["task-create-form", coordinationWritable("tasks")], ["task-event-form", coordinationWritable("tasks")], ["memory-form", coordinationWritable("memory")], ["artifact-form", coordinationWritable("artifacts")]]) {
      for (const input of $(form).querySelectorAll("input,textarea,select,button")) input.disabled = busy || !allowed;
    }
    $("task-create-section").hidden = !coordinationWritable("tasks");
    $("artifact-upload-section").hidden = !coordinationWritable("artifacts");
    $("memory-new").hidden = !coordinationWritable("memory"); $("memory-new").disabled = busy;
    $("memory-edit").hidden = !coordinationWritable("memory") || !data.memoryDetail || Boolean(data.memoryDraft); $("memory-edit").disabled = busy;
    $("memory-form").hidden = !data.memoryDraft || !coordinationWritable("memory");
    const actions = taskActions(), selected = $("task-event-kind").value;
    const values = data.eventDraft && !actions.includes(selected) ? [...actions, selected].filter(Boolean) : actions;
    replaceContent("task-event-kind", ...values.map((type) => { const option = node("option", "", () => (TASK_EVENTS[type])); option.value = type; return option; }));
    if (values.includes(selected)) $("task-event-kind").value = selected;
    $("task-event-form").hidden = !coordinationWritable("tasks") || !data.task || !values.length;
    const type = $("task-event-kind").value;
    $("task-review-fields").hidden = type !== "review_result"; $("task-recovery-fields").hidden = type !== "recovery_decided"; $("task-check-fields").hidden = type !== "verification_reported";
    $("task-event-artifacts").disabled = busy || !coordinationWritable("tasks") || !artifactEvents.has(type);
    const stale = data.eventDraft && data.eventDraft.version !== data.task?.task?.version;
    $("task-event-rebase").hidden = !stale;
    setText($("task-event-help"), () => (data.task ? tr("{0}{1} Recording an event does not execute commands.", () => (data.eventDraft ? tr("Draft is bound to version {0}", () => (data.eventDraft.version)) : tr("Current version {0}", () => (data.task.task.version))), () => (stale ? tr("; the server already has a newer version. Review the data and explicitly rebase the draft.") : tr(". Submission requires a button click; no automatic retry."))) : ""));
    $("task-event-submit").disabled = busy || !actions.includes(type) || Boolean(stale);
    if (data.memoryDraft) {
      const draft = data.memoryDraft, latest = data.memory.find((entry) => entry.id === draft.id);
      setText($("memory-version-notice"), () => (draft.id ? tr("Editing version {0}.{1}", () => (draft.version), () => (latest && latest.version !== draft.version ? tr(" Version {0} has already been published: saving the old draft will be rejected (409), without overwriting. Close the draft and select the current version.", () => (latest.version)) : tr(" Saving adds a new version; the previous one stays in history."))) : tr("New public entry for project readers. Do not include secrets or hidden context.")));
    }
  }
  function selectTask(id) {
    if (state.coordinationBusy || !state.coordination?.tasks.some((task) => task.id === id) || state.coordination.taskId === id) return;
    selectTaskData(state.coordination, id); renderCoordination(); scheduleRefresh();
  }
  function selectTaskData(data, id) {
    if (data.taskId === id) return;
    data.mapTaskTarget = "";
    data.taskId = id; data.task = null; data.eventDraft = null; data.fullTimeline = null; data.historyAfter = 0; data.historyMore = false;
    data.pending.delete("task-event"); $("task-event-form").reset(); state.coordinationEpoch += 1;
  }
  function captureTaskDraft(force = false) {
    const data = state.coordination, task = data?.task?.task;
    if (!task || state.coordinationBusy) return;
    const type = $("task-event-kind").value;
    if (!force && data.eventDraft?.type === type) return;
    const run = currentTaskRun(data);
    data.eventDraft = {type, taskId: task.id, version: task.version, runId: type === "run_started" ? clientId() : task.current_run_id, reviewRequestId: run?.review_request_id, refs: list(run?.artifacts).map((ref) => ({...ref}))};
    data.pending.delete("task-event");
    $("task-event-artifacts").value = artifactEvents.has(type) ? list(run?.artifacts).map((ref) => ref.artifact_id).join("\n") : "";
    $("task-check-artifact").value = list(run?.artifacts).find((ref) => ref.role === "evidence")?.artifact_id || "";
    updateCoordinationControls();
  }
  function renderMemory(data) {
    const cards = data.memory.map((entry) => {
      const card = record(entry.title, "", tr("Version {0} · {1}\nVersion author {2} · ID {3}", () => (entry.version), () => (dateText(entry.updated_at)), () => (entry.updated_by), () => (entry.id))); card.dataset.memoryId = entry.id;
      const button = node("button", "text-button", () => (tr("Select context and history"))); button.type = "button"; button.dataset.focusKey = `memory:${entry.id}`;
      button.setAttribute("aria-pressed", String(data.memoryId === entry.id)); button.addEventListener("click", () => selectMemory(entry.id)); appendOwned(card, () => (button)); return card;
    });
    if (!cards.length) cards.push(node("p", "empty-state", () => (data.ready.has("memory") ? tr("No published project memory yet.") : tr("Reading memory…"))));
    if (data.memoryTruncated) cards.push(node("p", "field-help", () => (tr("Showing the latest 1,000 entries."))));
    replaceContent("project-memory-list", ...cards);
    const detail = data.memoryDetail, entry = detail?.memory;
    replaceContent("project-memory-detail", entry ? record(entry.title, entry.body, tr("Current version {0} · ID {1}\nVersion author {2} · {3}", () => (entry.version), () => (entry.id), () => (entry.updated_by), () => (dateText(entry.updated_at)))) : node("p", "empty-state", () => (tr("Select a published memory entry."))));
    const versions = list(detail?.versions).map((version) => { const item = record(tr("Version {0} · {1}", () => (version.version), () => (version.title)), version.body, tr("Author {0} · {1}", () => (version.author_id), () => (dateText(version.created_at)))); item.dataset.version = version.version; return item; });
    if (detail?.truncated) versions.push(node("p", "field-help", () => (tr("Showing the latest 1,000 versions. Earlier versions have not been deleted."))));
    replaceContent("memory-history", ...versions);
    renderMemorySelection(data);
  }
  function renderMemorySelection(data) {
    const selected = [...data.memoryRefs.values()];
    const stale = selected.some((entry) => data.memory.find((item) => item.id === entry.id)?.version !== entry.version);
    const bytes = selected.reduce((sum, entry) => sum + utf8.encode(entry.title).length + utf8.encode(entry.body).length, 0);
    const cards = selected.map((entry) => {
      const changed = data.memory.find((item) => item.id === entry.id)?.version !== entry.version;
      const card = record(entry.title, changed ? tr("The version changed or is unavailable. Select the current entry again; the reference is not updated automatically.") : tr("The version matches the latest received snapshot."), tr("ID {0} · selected version {1}\nVersion author {2} · {3}", () => (entry.id), () => (entry.version), () => (entry.updated_by), () => (dateText(entry.updated_at))));
      card.dataset.memoryRef = entry.id; card.dataset.stale = String(changed);
      const remove = node("button", "text-button", () => (tr("Remove from selected context"))); remove.type = "button"; remove.dataset.focusKey = `memory-ref:${entry.id}`;
      remove.addEventListener("click", () => { state.coordination?.memoryRefs.delete(entry.id); if (state.coordination) renderMemorySelection(state.coordination); }); appendOwned(card, () => (remove)); return card;
    });
    replaceContent("memory-selected-list", ...cards);
    setText($("memory-selected-refs"), () => (selected.length ? JSON.stringify({memory_refs: selected.map((entry) => ({memory_id: entry.id, version: entry.version}))}, null, 2) : tr("Nothing selected.")));
    setText($("memory-selected-status"), () => (stale ? tr("Selected context is stale: copying is blocked until you explicitly select it again.") : tr("{0} / 4 entries · {1} / 16,384 UTF-8 bytes. Selection does not mean publication or execution.", () => (selected.length), () => numberText(bytes))));
    $("memory-copy-refs").disabled = !selected.length || stale || bytes > 16384;
    const entry = data.memoryDetail?.memory;
    $("memory-select-current").disabled = !entry || (selected.length >= 4 && !data.memoryRefs.has(entry.id));
  }
  function selectMemoryContext() {
    const data = state.coordination, entry = data?.memoryDetail?.memory;
    if (!entry || (data.memoryRefs.size >= 4 && !data.memoryRefs.has(entry.id))) return;
    const next = new Map(data.memoryRefs); next.set(entry.id, {...entry});
    if ([...next.values()].reduce((sum, item) => sum + utf8.encode(item.title).length + utf8.encode(item.body).length, 0) > 16384) { setText($("memory-selected-status"), () => (tr("Selection exceeds 16 KiB of UTF-8. Remove some entries; oversized context is not copied automatically."))); return; }
    data.memoryRefs = next; renderMemorySelection(data);
  }
  function selectMemory(id) {
    const data = state.coordination;
    if (state.coordinationBusy || !data?.memory.some((entry) => entry.id === id) || data.memoryId === id) return;
    if (data.memoryDraft && !window.confirm(tr("Close the current unpublished memory draft and select another entry?"))) return;
    closeMemoryDraft(); data.mapMemoryTarget = ""; data.memoryId = id; data.memoryDetail = null; state.coordinationEpoch += 1; renderCoordination(); scheduleRefresh();
  }
  function closeMemoryDraft() {
    if (state.coordination) { state.coordination.memoryDraft = null; state.coordination.pending.delete("memory"); }
    $("memory-form").reset(); $("memory-form").hidden = true;
  }
  function openMemoryDraft(edit) {
    if (!coordinationWritable("memory") || state.coordinationBusy) return;
    const data = state.coordination, entry = edit ? data.memoryDetail?.memory : null;
    if (edit && !entry) return;
    if (data.memoryDraft && !window.confirm(tr("Replace the open unpublished draft?"))) return;
    closeMemoryDraft(); data.memoryDraft = {id: entry?.id || "", version: entry?.version || 0};
    $("memory-title").value = entry?.title || ""; $("memory-body").value = entry?.body || "";
    setText($("memory-form-title"), () => (entry ? tr("New version of entry {0}", () => (entry.id)) : tr("New memory entry")));
    updateCoordinationControls(); $("memory-title").focus();
  }
  function renderSessions(data) {
    const labels = {fresh: tr("Fresh session lease"), stale: tr("Lease is stale or access was lost"), closed: tr("Session closed")};
    const cards = data.sessions.map((session) => {
      const card = record(formatText(["", " · ", ""], session.task_role, displayName(session.agent_id)), session.activity ? tr("Self-report: {0}", () => (session.activity)) : tr("No public self-report."),
        tr("Participant {0}\nSession {1}\nChannel {2} · run {3}\nRuntime {4} · model {5}\nRenewed {6}\nExpires {7} · deadline {8}{9}", () => (session.agent_id), () => (session.session_id), () => (session.channel_id), () => (session.run_id), () => (session.runtime), () => (session.model || tr("not reported")), () => (dateText(session.last_seen_at)), () => (dateText(session.expires_at)), () => (dateText(session.deadline_at)), () => (session.closed_at ? tr("\nClosed {0}", () => (dateText(session.closed_at))) : "")));
      card.dataset.sessionId = session.session_id; appendOwned(card, () => (statusTag(session.freshness, labels[session.freshness] || tr("Freshness unknown")))); return card;
    });
    if (!cards.length) cards.push(node("p", "empty-state", () => (data.ready.has("sessions") ? tr("The API returned no sessions in channels you can access.") : tr("Loading sessions…"))));
    if (data.sessionsTruncated) cards.push(node("p", "field-help", () => (tr("Showing up to 200 sessions; this is not the full archive."))));
    replaceContent("session-list", ...cards);
  }
  function artifactTitle(artifact) {
    return typeof artifact.title === "string" && artifact.title ? artifact.title : artifact.id;
  }
  function renderArtifacts(data) {
    const cards = data.artifacts.map((artifact) => {
      const card = record(artifactTitle(artifact), formatText([""," · ",""], () => (ARTIFACT_ROLES[artifact.role] || artifact.role), () => (artifact.role)), tr("ID {0}\nBase revision {1}\nSHA-256 {2}\n{3} bytes · author {4}\nStored {5}", () => (artifact.id), () => (artifact.base_revision), () => (artifact.sha256), () => numberText(number(artifact.size_bytes)), () => (artifact.author_id), () => (dateText(artifact.created_at))));
      card.dataset.artifactId = artifact.id; const button = node("button", "secondary-button", () => (tr("Download bytes after SHA-256 verification")));
      button.type = "button"; button.dataset.focusKey = `artifact:${artifact.id}`; button.disabled = state.coordinationBusy;
      button.addEventListener("click", () => void downloadArtifact(artifact.id)); appendOwned(card, () => (button)); return card;
    });
    if (!cards.length) cards.push(node("p", "empty-state", () => (data.ready.has("artifacts") ? tr("No artifacts in this project.") : tr("Loading artifacts…"))));
    replaceContent("artifact-list", ...cards); $("artifact-more").hidden = !data.artifactsMore; $("artifact-more").disabled = state.coordinationBusy;
  }
  const lines = (id) => $(id).value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  function boundedText(id, maximum, required = true) {
    const value = $(id).value.trim();
    const label = document.querySelector(`label[for="${id}"]`);
    if ((required && !value) || value.includes("\0") || utf8.encode(value).length > maximum) throw new ApiError(400, tr("Check “{0}”: limit {1} UTF-8 bytes, with no null characters.", label ? new LocalizedText(() => label.textContent) : id, maximum));
    return value;
  }
  async function coordinationMutation(name, path, method, payload, onSuccess, options = {}) {
    if (state.coordinationBusy || !isCoordination() || !state.project) return;
    const data = coordinationData(), context = state.context, projectId = state.project.id;
    const pending = pendingPayload(data.pending.get(name), {...payload}); data.pending.set(name, pending);
    const epoch = ++state.coordinationEpoch;
    state.coordinationBusy = true; clearError("coordination-error"); setText($("coordination-status"), () => (tr("Waiting for the server to confirm storage…"))); updateCoordinationControls(); renderNavigation();
    try {
      const result = await api(path, {method, body: pending.body, ...options});
      if (!scopeMatches(context, projectId, epoch)) return;
      data.pending.delete(name); onSuccess(result);
      setText($("coordination-status"), () => (result.replayed ? tr("The server confirmed the previously stored record; no new copy was created.") : tr("Stored by the server. This confirms storage, not task execution or correctness.")));
    } catch (error) {
      if (!scopeMatches(context, projectId, epoch)) return;
      showError(error, "coordination-error");
      setText($("coordination-status"), () => (error instanceof ApiError && error.status < 500 ? error.status === 409 ? tr("Change rejected due to a conflict. Your draft is preserved; review the current version. No automatic retry.") : tr("Storage was not confirmed. Check permissions and fields.") : tr("Outcome unknown. No automatic retry. Retrying an unchanged request uses the same client_id.")));
      if (error.status === 403 || error.status === 404) { clearCoordination(); handleReadError(error, context); return; }
      if (error instanceof ApiError && error.status < 500) data.pending.delete(name);
    } finally {
      if (scopeMatches(context, projectId, epoch)) { state.coordinationBusy = false; updateCoordinationControls(); renderNavigation(); scheduleRefresh(); }
    }
  }
  async function createTask(event) {
    event.preventDefault(); if (!coordinationWritable("tasks") || state.coordinationBusy || !$("task-create-form").reportValidity()) return;
    try {
      const payload = {title: boundedText("task-title", 200), owner_id: boundedText("task-owner", 128), reviewer_id: boundedText("task-reviewer", 128), scope: lines("task-scope"), acceptance: lines("task-acceptance")};
      if (payload.owner_id === payload.reviewer_id) throw new ApiError(400, tr("The assignee and reviewer must be different agents."));
      if (!payload.scope.length || payload.scope.length > 32 || !payload.acceptance.length || payload.acceptance.length > 32) throw new ApiError(400, tr("Provide 1 to 32 paths and 1 to 32 acceptance criteria."));
      await coordinationMutation("task-create", coordinationRoute("tasks"), "POST", payload, (result) => {
        if (result.task?.project_id !== state.project.id) throw new Error("Invalid task scope");
        state.coordination.taskId = result.task.id; state.coordination.task = null; $("task-create-form").reset(); $("task-create-section").open = false;
      });
    } catch (error) { showError(error, "coordination-error"); }
  }
  async function submitMemory(event) {
    event.preventDefault(); const draft = state.coordination?.memoryDraft;
    if (!draft || !coordinationWritable("memory") || state.coordinationBusy || !$("memory-form").reportValidity()) return;
    try {
      const payload = {title: boundedText("memory-title", 200), body: boundedText("memory-body", 16384)};
      if (draft.id) payload.expected_version = draft.version;
      await coordinationMutation("memory", coordinationRoute(`memory${draft.id ? `/${pathId(draft.id)}` : ""}`), draft.id ? "PUT" : "POST", payload, (result) => {
        if (result.memory?.project_id !== state.project.id) throw new Error("Invalid memory scope");
        state.coordination.memoryId = result.memory.id; closeMemoryDraft();
      });
    } catch (error) { showError(error, "coordination-error"); }
  }
  async function submitTaskEvent(event) {
    event.preventDefault(); if (!coordinationWritable("tasks") || state.coordinationBusy || !$("task-event-form").reportValidity()) return;
    captureTaskDraft();
    const data = state.coordination, draft = data?.eventDraft, context = state.context, projectId = state.project?.id, epoch = state.coordinationEpoch;
    if (!draft || !taskActions().includes(draft.type) || draft.version !== data.task?.task?.version) return;
    try {
      const payload = {type: draft.type, expected_version: draft.version, run_id: draft.runId, summary: boundedText("task-event-summary", 2500)};
      if (artifactEvents.has(draft.type)) {
        const ids = lines("task-event-artifacts");
        if (!ids.length || ids.length > 32 || new Set(ids).size !== ids.length) throw new ApiError(400, tr("Provide the complete set: 1 to 32 unique artifact IDs."));
        payload.artifacts = [];
        for (const id of ids) {
          let ref = draft.refs.find((candidate) => candidate.artifact_id === id);
          if (!ref) {
            const result = await api(`/v1/artifacts/${pathId(id)}`);
            if (!scopeMatches(context, projectId, epoch)) return;
            const artifact = result.artifact;
            if (artifact?.project_id !== projectId) throw new ApiError(400, tr("The artifact must belong to the selected project."));
            ref = {artifact_id: artifact.id, sha256: artifact.sha256, role: artifact.role};
          }
          payload.artifacts.push(ref);
        }
      }
      if (["review_result", "completion_reported"].includes(draft.type)) payload.review_request_id = draft.reviewRequestId;
      if (draft.type === "review_result") payload.verdict = $("task-review-verdict").value;
      if (draft.type === "recovery_decided") payload.recovery_action = $("task-recovery-action").value;
      if (draft.type === "verification_reported") {
        const artifact = payload.artifacts.find((ref) => ref.artifact_id === $("task-check-artifact").value.trim() && ref.role === "evidence");
        if (!artifact) throw new ApiError(400, tr("A verification report requires an evidence-role artifact from the current complete set."));
        const exitCode = $("task-check-exit").value === "" ? null : Number($("task-check-exit").value);
        if (exitCode !== null && !Number.isSafeInteger(exitCode)) throw new ApiError(400, tr("The exit code must be an integer."));
        payload.evidence = {status: $("task-check-result").value, command: boundedText("task-check-command", 2000), exit_code: exitCode, artifact};
      }
      if (!scopeMatches(context, projectId, epoch)) return;
      await coordinationMutation("task-event", coordinationRoute(`tasks/${pathId(draft.taskId)}/events`), "POST", payload, () => { data.eventDraft = null; data.fullTimeline = null; $("task-event-form").reset(); });
    } catch (error) { if (scopeMatches(context, projectId, epoch)) showError(error, "coordination-error"); }
  }
  async function allTaskEvents() {
    const data = state.coordination, taskId = data?.taskId, projectId = state.project?.id, context = state.context, epoch = state.coordinationEpoch;
    if (!taskId || state.coordinationBusy) return;
    $("task-timeline-all").disabled = true;
    try {
      // Bounded history loading, explicitly requested. Further pages need another click.
      const after = data.fullTimeline ? data.historyAfter : 0;
      const result = await api(coordinationRoute(`tasks/${pathId(taskId)}/events?after_version=${after}&limit=1000`));
      if (!scopeMatches(context, projectId, epoch) || data.taskId !== taskId) return;
      const events = new Map([...(data.fullTimeline || []), ...list(data.task?.events), ...list(result.events)].map((entry) => [entry.version, entry]));
      data.fullTimeline = [...events.values()].sort((a, b) => a.version - b.version);
      data.historyAfter = list(result.events).at(-1)?.version || after; data.historyMore = result.truncated === true; renderTasks(data);
    } catch (error) { if (scopeMatches(context, projectId, epoch)) showError(error, "coordination-error"); }
    finally { if (scopeMatches(context, projectId, epoch)) $("task-timeline-all").disabled = false; }
  }
  async function digest(bytes) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
  async function uploadArtifact(event) {
    event.preventDefault(); if (!coordinationWritable("artifacts") || state.coordinationBusy || !$("artifact-form").reportValidity()) return;
    const file = $("artifact-file").files[0], context = state.context, projectId = state.project.id, epoch = state.coordinationEpoch;
    try {
      if (!file || file.size < 1 || file.size > 2 * 1024 * 1024) throw new ApiError(413, tr("Select a file from 1 byte to 2 MiB."));
      const role = $("artifact-role").value, baseRevision = boundedText("artifact-base", 128), title = boundedText("artifact-title", 200, false);
      if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(title)) throw new ApiError(400, tr("Use a single-line title without control characters."));
      const bytes = new Uint8Array(await file.arrayBuffer()), sha256 = await digest(bytes);
      if (!scopeMatches(context, projectId, epoch)) return;
      let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      await coordinationMutation("artifact", coordinationRoute("artifacts"), "POST", {role, ...(title ? {title} : {}), base_revision: baseRevision, sha256, content_base64: btoa(binary)}, () => { $("artifact-form").reset(); $("artifact-upload-section").open = false; }, {artifactUpload: true});
    } catch (error) { if (scopeMatches(context, projectId, epoch)) showError(error, "coordination-error"); }
  }
  async function downloadArtifact(id) {
    const artifact = state.coordination?.artifacts.find((item) => item.id === id), projectId = state.project?.id, context = state.context, epoch = state.coordinationEpoch;
    if (!artifact || artifact.project_id !== projectId || state.coordinationBusy) return;
    try {
      const bytes = await api(`/v1/artifacts/${pathId(id)}/content`, {binary: true});
      if (!scopeMatches(context, projectId, epoch)) return;
      if (bytes.byteLength > 2 * 1024 * 1024 || bytes.byteLength !== number(artifact.size_bytes) || await digest(bytes) !== artifact.sha256) throw new ApiError(409, tr("Artifact integrity was not confirmed. Download cancelled."));
      if (!scopeMatches(context, projectId, epoch)) return;
      const url = URL.createObjectURL(new Blob([bytes], {type: "application/octet-stream"})); state.downloads.add(url);
      const link = node("a"); link.href = url; link.download = `${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.bin`; appendOwned(document.body, () => (link)); link.click(); link.remove();
      setTimeout(() => { URL.revokeObjectURL(url); state.downloads.delete(url); }, 1000);
      setText($("coordination-status"), () => (tr("Bytes and SHA-256 verified. The file was passed to the browser as .bin; its contents were not executed.")));
    } catch (error) { if (scopeMatches(context, projectId, epoch)) showError(error, "coordination-error"); }
  }

  // Administration is owner-only in the UI; the server independently enforces it.
  // Mutation requests are explicit, single-shot requests, never queued or retried.
  function clearAdminKey() {
    clearOnboardingResult();
    state.adminKey = ""; state.adminKeyVersion += 1;
    $("admin-issued-key").value = "";
    setText($("admin-key-target"), () => (""));
    setText($("admin-key-copy-status"), () => (""));
    if ($("admin-key-dialog").open) $("admin-key-dialog").close();
  }

  function clearAdminDelete() {
    state.adminDelete = null; state.adminDeleteEpoch += 1;
    state.adminDeleteLoading = false; state.adminDeleteSubmitting = false;
    setText($("admin-delete-target"), () => (""));
    $("admin-delete-counts").replaceChildren();
    $("admin-delete-confirm").value = ""; setOwnedValidity($("admin-delete-confirm"), () => (""));
    setText($("admin-delete-status"), () => (""));
    if ($("admin-delete-dialog").open) $("admin-delete-dialog").close();
    updateDeleteControls();
  }

  function updateDeleteControls() {
    const target = state.adminDelete;
    const ready = isOwner() && state.view === "admin" && $("admin-delete-dialog").open && target &&
      target.epoch === state.adminDeleteEpoch && target.context === state.context && target.authVersion === state.authVersion &&
      !state.adminDeleteLoading && !state.adminDeleteSubmitting && !state.adminBusy && !blockingAdminLoad();
    const matches = Boolean(ready && $("admin-delete-confirm").value === target.id);
    $("admin-delete-confirm").disabled = !ready;
    setOwnedValidity($("admin-delete-confirm"), () => (ready && !matches ? tr("The ID must exactly match the project ID, including case, with no extra spaces.") : ""));
    $("admin-delete-submit").disabled = !matches;
    setText($("admin-delete-cancel"), () => (state.adminDeleteSubmitting ? tr("Close (request already sent)") : tr("Cancel")));
  }

  function deliveryOwner() {
    return Boolean(state.key) && isOwner();
  }

  function invalidateDeliveryAlerts(clear = false) {
    clearTimeout(state.deliveryTimer); state.deliveryTimer = null;
    state.deliverySeq += 1; state.deliveryWriteSeq += 1; state.deliveryLinkSeq += 1;
    state.highlightMessage = ""; state.deliveryLoading = false; state.deliveryPolicyLoading = false;
    if (state.deliverySaving) { state.deliveryConflict = true; state.deliveryPolicyError = tr("Saving was not confirmed. Reload server settings before trying again; your draft is preserved."); }
    state.deliverySaving = false;
    if (clear) {
      state.deliveryAlerts = state.deliveryDraft = null;
      state.deliveryDirty = state.deliveryConflict = state.deliveryDenied = false;
      state.deliveryLastAttempt = 0; state.deliveryNotice = state.deliveryError = state.deliveryPolicyError = "";
      state.deliveryDraftSeq += 1;
    } else {
      if (state.deliveryAlerts) state.deliveryAlerts.status = "stale";
      scheduleDeliveryPoll(1000);
    }
    renderDeliveryAlerts();
  }

  function validateDeliveryPolicy(policy) {
    if (!policy || typeof policy.enabled !== "boolean" || !Number.isSafeInteger(policy.version) || policy.version < 0 ||
        !Number.isSafeInteger(policy.ack_timeout_seconds) || policy.ack_timeout_seconds < 60 || policy.ack_timeout_seconds > 86400 ||
        !Number.isSafeInteger(policy.reply_timeout_seconds) || policy.reply_timeout_seconds !== 0 && (policy.reply_timeout_seconds < policy.ack_timeout_seconds || policy.reply_timeout_seconds > 604800) ||
        !nativeReceiptTime(policy.enabled_at) || !nativeReceiptTime(policy.updated_at) || !policy.updated_at || policy.enabled && !policy.enabled_at) throw new Error("Invalid delivery policy");
    return {...policy};
  }

  function validateDeliveryAlertPage(data) {
    const policy = validateDeliveryPolicy(data?.policy);
    const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
    if (!Array.isArray(data.alerts) || data.alerts.length > 50 || !Number.isSafeInteger(data.total) || data.total < data.alerts.length ||
        typeof data.truncated !== "boolean" || !nativeReceiptTime(data.generated_at) || !data.generated_at || !nativeReceiptTime(data.as_of) || !data.as_of ||
        !(data.next_cursor === null || typeof data.next_cursor === "string" && data.next_cursor.length > 0 && data.next_cursor.length <= 4096) ||
        data.truncated !== Boolean(data.next_cursor) || !policy.enabled && (data.alerts.length || data.total || data.truncated)) throw new Error("Invalid delivery alert page");
    const pairs = new Set();
    for (const row of data.alerts) {
      if (!row || ![row.message_id, row.project_id, row.channel_id, row.author_id, row.recipient_id].every(id) ||
          !Number.isSafeInteger(row.message_seq) || row.message_seq < 1 || !["unacknowledged", "unanswered"].includes(row.reason) ||
          !row.created_at || !row.due_at || ![row.created_at, row.due_at, row.offered_at, row.seen_at, row.accepted_at, row.delivered_at, row.legacy_accepted_at, row.answered_at].every(nativeReceiptTime)) throw new Error("Invalid delivery alert");
      const pair = JSON.stringify([row.message_id, row.recipient_id]);
      if (pairs.has(pair)) throw new Error("Duplicate delivery alert");
      pairs.add(pair);
    }
    return {...data, policy};
  }

  function setDeliveryPolicy(policy, replaceDraft = false) {
    if (replaceDraft || !state.deliveryDraft || !state.deliveryDirty && !state.deliveryConflict) {
      state.deliveryDraft = {enabled: policy.enabled, ack: String(policy.ack_timeout_seconds / 60), replyEnabled: policy.reply_timeout_seconds !== 0,
        reply: String((policy.reply_timeout_seconds || Math.max(1800, policy.ack_timeout_seconds)) / 60), version: policy.version};
      state.deliveryDirty = state.deliveryConflict = false;
      state.deliveryDraftSeq += 1;
    } else if (state.deliveryDraft.version !== policy.version) {
      state.deliveryConflict = true;
      state.deliveryPolicyError = tr("Settings changed on the server. Your draft is preserved; replace it with current settings before saving again.");
    }
  }

  async function loadDeliveryAlerts({more = false, preserveList = false} = {}) {
    if (!deliveryOwner() || document.hidden || navigator.onLine === false || state.deliverySaving || state.deliveryPolicyLoading || state.deliveryDenied || preserveList && state.deliveryLoading) return;
    const previous = state.deliveryAlerts;
    if (more && (state.deliveryLoading || previous?.status !== "ready" || !previous?.cursor || previous.policy.version !== previous.listPolicyVersion)) return;
    const auth = state.authVersion, context = state.context, request = ++state.deliverySeq;
    const cursor = more ? previous.cursor : null;
    const valid = () => deliveryOwner() && currentAuth(auth) && current(context) && state.deliverySeq === request;
    state.deliveryLoading = true; state.deliveryLastAttempt = Date.now(); state.deliveryError = "";
    if (previous && !more) previous.status = "stale";
    renderDeliveryAlerts();
    try {
      const page = validateDeliveryAlertPage(await api(`/v1/admin/delivery-alerts?limit=50${cursor ? `&cursor=${pathId(cursor)}` : ""}`));
      if (!valid()) return;
      if (more && (state.deliveryAlerts !== previous || previous.listPolicyVersion !== page.policy.version || previous.cursor !== cursor || previous.windowAt !== page.as_of)) throw new Error("Changed delivery alert page");
      setDeliveryPolicy(page.policy);
      const holdList = !more && preserveList && previous &&
        (previous.expanded || $("delivery-alert-list").contains(document.activeElement));
      const rows = more ? [...previous.rows] : page.alerts;
      if (more) for (const row of page.alerts) {
        const index = rows.findIndex(item => item.message_id === row.message_id && item.recipient_id === row.recipient_id);
        if (index < 0) rows.push(row); else rows[index] = row;
      }
      state.deliveryAlerts = {policy: page.policy, total: page.total, generatedAt: page.generated_at, asOf: page.as_of, status: "ready",
        rows: holdList ? previous.rows : rows, listTotal: holdList ? previous.listTotal : page.total,
        listAt: holdList ? previous.listAt : page.generated_at, windowAt: holdList ? previous.windowAt : page.as_of, cursor: holdList ? previous.cursor : page.next_cursor,
        listPolicyVersion: holdList ? previous.listPolicyVersion : page.policy.version,
        expanded: more || Boolean(holdList && previous.expanded), updates: Boolean(holdList)};
    } catch (error) {
      if (!valid()) return;
      if ([401, 403].includes(error.status)) {
        state.deliveryAlerts = state.deliveryDraft = null; state.deliveryDirty = state.deliveryConflict = false;
        state.deliveryDenied = true; clearTimeout(state.deliveryTimer); state.deliveryTimer = null;
      } else if (state.deliveryAlerts) state.deliveryAlerts.status = "unavailable";
      state.deliveryError = error.status === 409 ? tr("The alert list changed. Refresh it before loading another page.") : tr("The current delivery state is unknown. Refresh to check again.");
    } finally {
      if (valid()) { state.deliveryLoading = false; renderDeliveryAlerts(); }
    }
  }

  function scheduleDeliveryPoll(delay = 25000) {
    clearTimeout(state.deliveryTimer); state.deliveryTimer = null;
    if (!deliveryOwner() || document.hidden || navigator.onLine === false || state.deliveryDenied) return;
    const auth = state.authVersion;
    state.deliveryTimer = setTimeout(async () => {
      state.deliveryTimer = null;
      if (!deliveryOwner() || !currentAuth(auth) || document.hidden) return;
      const pending = loadDeliveryAlerts({preserveList: true}), request = state.deliverySeq;
      await pending;
      if (deliveryOwner() && currentAuth(auth) && request === state.deliverySeq) scheduleDeliveryPoll();
    }, delay);
  }

  function deliveryConnectivityChanged() {
    if (!deliveryOwner()) return;
    clearTimeout(state.deliveryTimer); state.deliveryTimer = null;
    state.deliverySeq += 1; state.deliveryLoading = false;
    if (state.deliveryAlerts) state.deliveryAlerts.status = "unavailable";
    state.deliveryError = tr("The current delivery state is unknown. Refresh to check again.");
    renderDeliveryAlerts();
    if (navigator.onLine !== false) scheduleDeliveryPoll(0);
  }

  function captureDeliveryDraft() {
    if (!deliveryOwner() || !state.deliveryDraft || state.deliverySaving || state.deliveryPolicyLoading) return;
    const draft = state.deliveryDraft;
    draft.enabled = $("delivery-policy-enabled").checked; draft.ack = $("delivery-policy-ack").value;
    draft.replyEnabled = $("delivery-policy-reply-enabled").checked; draft.reply = $("delivery-policy-reply").value;
    state.deliveryDirty = true; state.deliveryDraftSeq += 1; state.deliveryNotice = "";
    renderDeliveryAlerts();
  }

  function deliveryPolicyPayload(draft) {
    const ack = Number(draft.ack) * 60, reply = draft.replyEnabled ? Number(draft.reply) * 60 : 0;
    if (!Number.isFinite(ack) || !Number.isFinite(reply) || Math.abs(ack - Math.round(ack)) > 1e-6 || Math.abs(reply - Math.round(reply)) > 1e-6 ||
        ack < 60 || ack > 86400 || draft.replyEnabled && (reply < ack || reply > 604800)) return null;
    return {enabled: draft.enabled, ack_timeout_seconds: Math.round(ack), reply_timeout_seconds: Math.round(reply), expected_version: draft.version};
  }

  async function reloadDeliveryPolicy() {
    if (!deliveryOwner() || state.deliverySaving || state.deliveryPolicyLoading) return;
    const auth = state.authVersion, context = state.context, request = ++state.deliveryWriteSeq, draftSeq = state.deliveryDraftSeq;
    state.deliverySeq += 1; state.deliveryLoading = false; state.deliveryPolicyLoading = true;
    const valid = () => deliveryOwner() && currentAuth(auth) && current(context) && request === state.deliveryWriteSeq;
    renderDeliveryAlerts();
    try {
      const policy = validateDeliveryPolicy((await api("/v1/admin/delivery-policy")).policy);
      if (!valid() || draftSeq !== state.deliveryDraftSeq) return;
      setDeliveryPolicy(policy, true); state.deliveryPolicyError = ""; state.deliveryDenied = false;
      state.deliveryNotice = tr("Server settings loaded. Monitoring changes only when you save.");
    } catch (error) {
      if (valid()) {
        if ([401, 403].includes(error.status)) { state.deliveryAlerts = state.deliveryDraft = null; state.deliveryDenied = true; }
        state.deliveryPolicyError = tr("The current delivery state is unknown. Refresh to check again.");
      }
    } finally {
      if (valid()) { state.deliveryPolicyLoading = false; renderDeliveryAlerts(); scheduleDeliveryPoll(0); }
    }
  }

  async function saveDeliveryPolicy(event) {
    event?.preventDefault();
    if (!deliveryOwner() || state.view !== "admin" || state.adminSection !== "delivery-alerts" || !state.deliveryDraft || state.deliveryConflict || state.deliverySaving || state.deliveryPolicyLoading || state.deliveryDenied) return;
    captureDeliveryDraft();
    const body = deliveryPolicyPayload(state.deliveryDraft);
    if (!body) { state.deliveryPolicyError = tr("Enter an acknowledgement deadline of 1–1440 minutes and an optional reply deadline between that value and 10080 minutes, to the nearest second."); renderDeliveryAlerts(); return; }
    const auth = state.authVersion, context = state.context, request = ++state.deliveryWriteSeq;
    const valid = () => deliveryOwner() && currentAuth(auth) && current(context) && request === state.deliveryWriteSeq;
    state.deliverySeq += 1; state.deliveryLoading = false; state.deliverySaving = true; state.deliveryPolicyError = "";
    state.deliveryNotice = tr("Saving deadlines… The request is not retried automatically.");
    if (state.deliveryAlerts) state.deliveryAlerts.status = "stale";
    renderDeliveryAlerts();
    try {
      const policy = validateDeliveryPolicy((await api("/v1/admin/delivery-policy", {method: "PUT", body})).policy);
      if (!valid()) return;
      if (policy.version !== body.expected_version + 1 || policy.enabled !== body.enabled || policy.ack_timeout_seconds !== body.ack_timeout_seconds || policy.reply_timeout_seconds !== body.reply_timeout_seconds) throw new Error("Unconfirmed policy write");
      setDeliveryPolicy(policy, true);
      state.deliveryAlerts = null;
      state.deliveryNotice = policy.enabled ? tr("Settings saved. New addressed messages are monitored from the enabled time.") : tr("Settings saved. Deadline monitoring is off.");
    } catch (error) {
      if (!valid()) return;
      if ([401, 403].includes(error.status)) { state.deliveryAlerts = state.deliveryDraft = null; state.deliveryDenied = true; }
      state.deliveryConflict = true;
      state.deliveryPolicyError = error.status === 409 ? tr("Settings changed on the server. Your draft is preserved; replace it with current settings before saving again.") : tr("Saving was not confirmed. Reload server settings before trying again; your draft is preserved.");
      state.deliveryNotice = "";
    } finally {
      if (valid()) { state.deliverySaving = false; renderDeliveryAlerts(); scheduleDeliveryPoll(0); }
    }
  }

  function renderDeliveryAlerts() {
    const owner = deliveryOwner(), data = state.deliveryAlerts, draft = state.deliveryDraft;
    $("delivery-alert-banner").hidden = !owner;
    if (!owner) {
      $("delivery-alert-list").replaceChildren(); $("delivery-alert-list").deliveryRows = null; $("delivery-policy-form").reset();
      for (const id of ["delivery-alert-banner-title", "delivery-alert-banner-detail", "delivery-policy-status", "delivery-policy-error", "delivery-alert-status", "delivery-alert-error"]) setText($(id), "");
      return;
    }
    const ready = data?.status === "ready" && !state.deliveryError;
    const title = ready ? !data.policy.enabled ? tr("Delivery monitoring is off") : data.total ? tr("{0} overdue recipient deliveries", data.total) : tr("No overdue messages in the latest check") : state.deliveryLoading ? tr("Checking delivery deadlines…") : tr("Delivery status unavailable");
    $("delivery-alert-banner").dataset.state = ready ? !data.policy.enabled ? "off" : data.total ? "overdue" : "clear" : state.deliveryLoading ? "loading" : "unavailable";
    setText($("delivery-alert-banner-title"), title);
    setText($("delivery-alert-banner-detail"), ready ? data.policy.enabled ? joinText([tr("Last checked: {0}", dateText(data.generatedAt)), tr("Deadlines through {0}", dateText(data.asOf))], " · ") : tr("Monitoring is disabled until an owner saves enabled settings.") : tr("The current delivery state is unknown. Refresh to check again."));
    setText($("delivery-alert-open"), ready && !data.policy.enabled ? tr("Configure deadlines") : tr("Delivery alerts"));
    const disabled = !draft || state.deliverySaving || state.deliveryPolicyLoading || state.deliveryDenied;
    for (const id of ["delivery-policy-enabled", "delivery-policy-ack", "delivery-policy-reply-enabled", "delivery-policy-reply"]) $(id).disabled = disabled;
    if (draft) {
      $("delivery-policy-enabled").checked = draft.enabled; $("delivery-policy-ack").value = draft.ack;
      $("delivery-policy-reply-enabled").checked = draft.replyEnabled; $("delivery-policy-reply").value = draft.reply;
      $("delivery-policy-reply").disabled = disabled || !draft.replyEnabled;
    }
    $("delivery-policy-save").disabled = disabled || state.deliveryConflict;
    $("delivery-policy-reload").disabled = state.deliverySaving || state.deliveryPolicyLoading;
    setText($("delivery-policy-status"), state.deliveryNotice);
    setText($("delivery-policy-error"), state.deliveryPolicyError); $("delivery-policy-error").hidden = !state.deliveryPolicyError;
    setText($("delivery-alert-error"), state.deliveryError); $("delivery-alert-error").hidden = !state.deliveryError;
    const status = data ? [tr("{0} loaded · {1} currently overdue in this window · checked {2}", data.rows.length, data.listTotal, dateText(data.listAt)), tr("Deadlines through {0}", dateText(data.windowAt)),
      data.updates ? tr("Updates available. Refresh the list when ready; the displayed rows are from its previous check.") : "", !ready ? tr("The displayed list is not current. Refresh to verify its status.") : ""].filter(Boolean) : [tr("Delivery alerts have not been loaded yet.")];
    setText($("delivery-alert-status"), joinText(status, " "));
    // Preserve row nodes/focus during summary-only polls and form editing.
    const rows = data?.rows || null;
    const emptyState = !ready ? "unconfirmed" : !data?.policy.enabled ? "off" : "empty";
    if ($("delivery-alert-list").deliveryRows !== rows || !rows?.length && $("delivery-alert-list").deliveryEmptyState !== emptyState) {
      $("delivery-alert-list").deliveryRows = rows;
      $("delivery-alert-list").deliveryEmptyState = emptyState;
      replaceContent("delivery-alert-list", ...list(rows).map(row => {
        const card = node("article", "admin-record delivery-alert-row"); card.dataset.alertMessage = row.message_id; card.dataset.alertRecipient = row.recipient_id;
        appendOwned(card, () => node("h4", "", () => row.reason === "unacknowledged" ? tr("No acknowledgement by the deadline") : tr("No direct reply by the deadline")),
          () => node("p", "field-help", () => tr("Message {0} · #{1} · project {2}", row.message_id, row.channel_id, row.project_id)),
          () => node("p", "field-help", () => tr("{0} → {1} · sent {2} · deadline {3}", row.author_id, row.recipient_id, dateText(row.created_at), dateText(row.due_at))));
        const stages = node("div", "receipt-states");
        for (const [name, timestamp] of [[tr("Offered to the CLI"), row.offered_at], [tr("Viewed"), row.seen_at], [tr("Reported acceptance"), row.accepted_at], [tr("Adapter delivered"), row.delivered_at], [tr("Adapter accepted"), row.legacy_accepted_at], [tr("Direct reply recorded"), row.answered_at]]) appendOwned(stages, () => node("span", "receipt-state", () => formatText(["", ": ", ""], name, timestamp ? dateText(timestamp) : tr("No report"))));
        const open = node("button", "text-button", () => tr("Open message")); open.type = "button"; open.dataset.focusKey = `delivery:${row.message_id}:${row.recipient_id}`;
        open.addEventListener("click", () => void openDeliveryMessage(row)); appendOwned(card, () => stages, () => open); return card;
      }));
      if (data && !rows.length) appendOwned($("delivery-alert-list"), () => node("p", "empty-state", () => !ready ? tr("The displayed list is not current. Refresh to verify its status.") : !data.policy.enabled ? tr("Monitoring is disabled until an owner saves enabled settings.") : tr("No overdue messages were returned by this check.")));
    }
    $("delivery-alert-more").hidden = !data?.cursor;
    $("delivery-alert-more").disabled = state.deliveryLoading || !ready || data?.policy.version !== data?.listPolicyVersion;
    $("delivery-alert-refresh").disabled = state.deliverySaving || state.deliveryPolicyLoading;
  }

  async function openDeliveryMessage(row) {
    if (!deliveryOwner()) return;
    const auth = state.authVersion;
    let context = state.context, request = ++state.deliveryLinkSeq;
    const valid = () => deliveryOwner() && currentAuth(auth) && current(context) && request === state.deliveryLinkSeq;
    try {
      const message = (await api(`/v1/messages/${pathId(row.message_id)}`)).message;
      if (!valid()) return;
      if (!message || message.id !== row.message_id || message.channel_id !== row.channel_id || message.seq !== row.message_seq || message.author_id !== row.author_id || !list(message.recipient_ids).includes(row.recipient_id)) throw new Error("Message identity changed");
      const projects = list((await api("/v1/projects")).projects);
      if (!valid()) return;
      const project = projects.find(item => item.id === row.project_id && !item.archived_at);
      if (!project) throw new Error("Project unavailable");
      let pending = selectProject(project, "chat"); context = state.context; request = state.deliveryLinkSeq; await pending;
      if (!valid() || state.project?.id !== row.project_id) return;
      const channel = state.channels.find(item => item.id === row.channel_id && item.project_id === row.project_id);
      if (!channel) throw new Error("Channel unavailable");
      pending = selectChannel(channel); context = state.context; request = state.deliveryLinkSeq; await pending;
      if (!valid() || state.channel?.id !== row.channel_id) return;
      // A directly fetched target may be ahead of REST replay. Keep messageSeq
      // unchanged so jumping never acknowledges unseen messages in that gap.
      state.messages.set(message.id, message); state.highlightMessage = message.id; renderMessages();
      const article = [...$("message-list").querySelectorAll("[data-message-id]")].find(item => item.dataset.messageId === message.id && item.classList.contains("message"));
      article?.scrollIntoView({block: "center"}); article?.focus({preventScroll: true});
    } catch (error) {
      if (valid()) { state.deliveryError = tr("Message access or identity changed. Reload the alert list."); renderDeliveryAlerts(); }
    }
  }

  async function selectDeliveryAlerts() {
    if (!deliveryOwner()) return;
    if (state.view !== "admin") await selectAdmin();
    if (!deliveryOwner() || state.view !== "admin") return;
    setAdminSection("delivery-alerts"); renderDeliveryAlerts();
    await loadDeliveryAlerts(); scheduleDeliveryPoll();
  }

  function clearAdminData() {
    invalidateDeliveryAlerts(true);
    clearAdminKey(); clearAdminDelete(); state.admin = null; state.adminLoading = false; state.adminBusy = false;
    state.onboarding = null;
    clearOnboardingGuidance("guide");
    state.adminReadSeq += 1; state.adminLoadBackground = false;
    for (const id of ["admin-principal-list", "admin-project-list", "admin-audit-list", "admin-delivery-list", "admin-access-agent", "admin-access-project", "admin-access-channel", "admin-channel-project", "admin-onboarding-list", "admin-onboarding-project", "admin-onboarding-channels"]) $(id).replaceChildren();
    for (const id of ["admin-principal-form", "admin-project-form", "admin-channel-form", "admin-access-form", "admin-onboarding-form"]) {
      $(id).reset();
      for (const input of $(id).querySelectorAll("input")) setOwnedValidity(input, () => (""));
    }
    for (const id of ["admin-status", "admin-principal-count", "admin-project-count", "admin-access-current", "admin-access-help"]) setText($(id), () => (""));
    $("admin-audit-truncated").hidden = true; $("admin-delivery-truncated").hidden = true;
    clearError("admin-error"); updateAdminControls();
  }

  const adminPrincipal = () => list(state.admin?.principals).find((principal) => principal.id === $("admin-access-agent").value);
  const activeAdminProjects = () => list(state.admin?.projects).filter((project) => !project.archived_at);
  const adminMembership = (scope, id) => list(state.admin?.[scope === "project" ? "project_members" : "channel_members"])
    .find((member) => member.agent_id === $("admin-access-agent").value && member[`${scope}_id`] === id);
  const accessName = (member) => member ? member.can_write === true ? tr("read and write") : tr("read") : tr("no access");

  function adminOptions(id, items, placeholder) {
    const select = $(id), previous = select.value;
    const empty = node("option", "", () => (placeholder)); empty.value = "";
    replaceContent(id, empty, ...items.map((item) => {
      const option = node("option", "", () => (`${item.name || item.id} (${item.id})`)); option.value = item.id; return option;
    }));
    if (items.some((item) => item.id === previous)) select.value = previous;
  }

  function updateAccessChannels() {
    adminOptions("admin-access-channel", list(state.admin?.channels).filter((channel) => channel.project_id === $("admin-access-project").value), tr("Select a channel"));
  }

  function syncAccessLevel() {
    const scope = $("admin-access-scope").value;
    const member = adminMembership(scope, $(scope === "project" ? "admin-access-project" : "admin-access-channel").value);
    $("admin-access-level").value = member ? member.can_write === true ? "write" : "read" : "none";
  }

  function updateAdminControls() {
    const unavailable = !isOwner() || !state.admin || state.adminBusy || blockingAdminLoad() || $("admin-delete-dialog").open;
    for (const control of $("admin-panel").querySelectorAll("input,select,button")) control.disabled = unavailable;
    for (const button of $("admin-principal-list").querySelectorAll("button[data-admin-action='revoke-key']")) {
      const principal = list(state.admin?.principals).find((item) => item.id === button.dataset.principalId);
      button.disabled = unavailable || principal?.key_active !== true;
    }
    for (const button of $("admin-project-list").querySelectorAll("button[data-project-action='delete']")) {
      const project = list(state.admin?.projects).find((item) => item.id === button.dataset.projectId);
      button.disabled = unavailable || !project?.archived_at;
    }
    const principal = adminPrincipal(), projectId = $("admin-access-project").value;
    const activeProject = activeAdminProjects().some((project) => project.id === projectId);
    const channelScope = $("admin-access-scope").value === "channel";
    const projectMember = adminMembership("project", projectId);
    const channelId = $("admin-access-channel").value;
    const channelMember = adminMembership("channel", channelId);
    const access = $("admin-access-level").value;
    $("admin-access-channel-field").hidden = !channelScope;
    $("admin-access-channel").required = channelScope;
    $("admin-access-channel").disabled = unavailable || !channelScope || !projectId;
    const writeOption = $("admin-access-level").querySelector("option[value='write']");
    writeOption.disabled = !principal || principal.kind !== "agent" || (channelScope && projectMember?.can_write !== true);
    const invalid = !principal || !activeProject || (channelScope && !channelId) ||
      (access === "write" && writeOption.disabled) || (channelScope && access !== "none" && !projectMember);
    $("admin-access-submit").disabled = unavailable || invalid;
    setText($("admin-access-current"), () => (principal && projectId
      ? tr("Current access: project — {0}{1}. Account: {2} ({3}).", () => (accessName(projectMember)), () => (channelScope && channelId ? tr("; channel — {0}", () => (accessName(channelMember))) : ""), () => (principal.id), () => (principal.kind))
      : tr("Select an account and parent project. Owner accounts cannot be modified through the web interface.")));
    setText($("admin-access-help"), () => (channelScope && !projectMember
      ? tr("Before granting channel access, switch to “Project access” and explicitly save the parent permission.")
      : channelScope && projectMember.can_write !== true
        ? tr("Before granting channel write access, explicitly grant write access to its parent project. Viewers cannot receive write access.")
        : tr("The change takes effect only after confirmation. The server rechecks permissions and records an audit entry.")));
    $("refresh-button").disabled = state.adminBusy || blockingAdminLoad() || $("admin-delete-dialog").open;
    updateOnboardingControls(unavailable);
    updateDeleteControls();
  }

  function renderAdminProjects() {
    const projects = list(state.admin?.projects);
    const archivedCount = projects.filter((project) => project.archived_at).length;
    setText($("admin-project-count"), () => (tr("{0} active · {1} archived", () => (projects.length - archivedCount), () => (archivedCount))));
    replaceContent("admin-project-list", ...projects.map((project) => {
      const archived = Boolean(project.archived_at);
      const card = node("article", "admin-project"); card.dataset.projectId = project.id;
      const heading = node("div", "heading-row");
      const status = node("span", "admin-project-state", () => (archived ? tr("Archived") : tr("Active")));
      status.dataset.archived = String(archived);
      appendOwned(heading, () => (node("h4", "", () => (project.name || project.id))), () => (status));
      appendOwned(card, () => (heading), () => (node("p", "field-help", () => (tr("ID: {0} · state version: {1}", () => (project.id), () => (Number.isSafeInteger(project.lifecycle_version) ? project.lifecycle_version : tr("not received")))))));
      if (archived) appendOwned(card, () => (node("p", "field-help", () => (tr("Archived: {0}. History is preserved; ordinary access is closed.", () => (dateText(project.archived_at)))))));
      else appendOwned(card, () => (node("p", "field-help", () => (tr("Participant access is determined by project and channel permissions. Archive the project before deletion.")))));
      const actions = node("div", "admin-actions");
      const definitions = [["history", archived ? tr("Read archive") : tr("Open history")],
        [archived ? "restore" : "archive", archived ? tr("Restore…") : tr("Archive…")], ["delete", tr("Permanently delete…")]];
      for (const [action, label] of definitions) {
        const button = node("button", action === "delete" ? "secondary-button danger-button" : "secondary-button", () => (label));
        button.type = "button"; button.dataset.projectAction = action; button.dataset.projectId = project.id;
        button.dataset.focusKey = `project-action:${project.id}:${action}`;
        if (action === "delete") button.disabled = !archived;
        button.addEventListener("click", () => {
          if (!isOwner() || state.adminBusy || blockingAdminLoad() || $("admin-delete-dialog").open) return;
          if (action === "history") void selectProject(project, "chat");
          else if (action === "delete") void openProjectDeletion(project);
          else void changeProjectLifecycle(project, action);
        });
        appendOwned(actions, () => (button));
      }
      appendOwned(card, () => (actions));
      return card;
    }));
    if (!projects.length) appendOwned($("admin-project-list"), () => (node("p", "empty-state", () => (tr("No projects yet. Create the first project below.")))));
  }

  async function changeProjectLifecycle(project, action) {
    if (!isOwner() || state.view !== "admin" || state.adminBusy || blockingAdminLoad() || !["archive", "restore"].includes(action)) return;
    const archive = action === "archive";
    if (archive === Boolean(project.archived_at)) return;
    const question = archive
      ? tr("Archive project “{0}” ({1})? History and permissions will be preserved. Agents and viewers will lose access, and writes will be blocked. The owner can read the archive. External work already dispatched and the agent’s global heartbeat will not be stopped.", () => (project.name), () => (project.id))
      : tr("Restore project “{0}” ({1})? Previous participant permissions will take effect again: agents and viewers regain their prior access, including write access for agents previously granted it.", () => (project.name), () => (project.id));
    if (!window.confirm(question)) return;
    await adminMutation(`/v1/admin/projects/${pathId(project.id)}/${action}`, "POST", {},
      archive ? tr("Project {0} archived. History and permissions are preserved; ordinary access is closed.", () => (project.id)) : tr("Project {0} restored. Previous participant permissions apply again.", () => (project.id)),
      (result) => {
        if (result.project?.id !== project.id || Boolean(result.project.archived_at) !== archive || !Number.isSafeInteger(result.project.lifecycle_version)) throw new Error("Invalid lifecycle response");
        state.admin.projects = list(state.admin.projects).map((item) => item.id === project.id ? result.project : item);
        state.projects = activeAdminProjects();
        if (state.project?.id === project.id) state.project = result.project;
        renderAdmin(); renderNavigation(); updatePermissions();
      });
  }

  function forgetProjectContent(projectId) {
    const selected = state.project?.id === projectId;
    const channelIds = new Set(list(state.admin?.channels).filter((channel) => channel.project_id === projectId).map((channel) => channel.id));
    if (selected) for (const channel of state.channels) channelIds.add(channel.id);
    for (const id of channelIds) state.cursors.delete(id);
    state.projects = state.projects.filter((project) => project.id !== projectId);
    if (!selected) return;
    clearNativeReceipts();
    state.project = null; state.channel = null; state.channels = []; state.agents = []; state.notes = []; state.notesTruncated = false;
    clearOverview();
    clearProjectNative();
    clearProjectMap();
    state.messages.clear(); state.events.clear(); state.messageSeq = 0;
    state.dataReady = false; state.projectReady = false; state.loading = false; state.sending = false; state.publishing = false;
    clearDrafts(); clearCoordination(); clearNativeActivity(); renderMessages(); renderEvents(); renderNotes(); renderAgents(); renderRecipients(); updatePermissions();
    $("history-notice").hidden = true;
    setText($("channel-description"), () => ("")); setText($("current-channel"), () => (tr("No selected channel")));
    setText($("channel-feed-name"), () => (""));
    renderNavigation();
  }

  async function openProjectDeletion(project) {
    if (!isOwner() || state.view !== "admin" || !project.archived_at || state.adminBusy || blockingAdminLoad()) return;
    clearAdminKey(); clearAdminDelete(); clearError("admin-error");
    const epoch = state.adminDeleteEpoch, context = state.context, authVersion = state.authVersion;
    state.adminDeleteLoading = true;
    setText($("admin-delete-target"), () => (tr("Project: {0} ({1}).", () => (project.name), () => (project.id))));
    setText($("admin-delete-status"), () => (tr("Loading the current deletion inventory. Deletion is unavailable until then…")));
    $("admin-delete-dialog").showModal(); updateAdminControls(); $("admin-delete-cancel").focus();
    const validTarget = () => current(context) && authVersion === state.authVersion && isOwner() && state.view === "admin" &&
      epoch === state.adminDeleteEpoch && $("admin-delete-dialog").open;
    try {
      const preview = await api(`/v1/admin/projects/${pathId(project.id)}/deletion-preview`);
      if (!validTarget()) return;
      const fields = [["channels", tr("Channels")], ["messages", tr("Messages")], ["notes", tr("Notes")],
        ["receipts", tr("Receipts")], ["events", tr("Events")], ["project_members", tr("Project access grants")], ["channel_members", tr("Channel access grants")]];
      for (const [key, label] of [["navigation_reads", tr("GUI read positions")], ["onboarding_invitations", tr("Onboarding invitations")], ["tasks", tr("Tasks")], ["task_runs", tr("Task run records")], ["task_events", tr("Task events")], ["memory", tr("Memory entries")], ["memory_versions", tr("Memory versions")], ["artifacts", tr("Artifacts")], ["artifact_bytes", tr("Artifact bytes")], ["sessions", tr("Sessions")], ["native_activity", tr("CLI activity reports")]]) {
        if (Object.hasOwn(preview.counts || {}, key)) fields.push([key, label]);
      }
      if (preview.project?.id !== project.id || !Number.isSafeInteger(preview.project.lifecycle_version) || preview.project.lifecycle_version < 0 ||
        !preview.counts || fields.some(([key]) => !Number.isSafeInteger(preview.counts[key]) || preview.counts[key] < 0)) throw new Error("Invalid deletion preview");
      if (preview.can_delete !== true || !preview.project.archived_at) {
        setText($("admin-delete-status"), () => (tr("The project is no longer archived. Deletion is unavailable. Close this dialog and refresh the project list.")));
        return;
      }
      state.adminDelete = {id: project.id, version: preview.project.lifecycle_version, epoch, context, authVersion};
      setText($("admin-delete-target"), () => (tr("Project: {0} · exact ID: {1} · state version: {2}.", () => (preview.project.name), () => (project.id), () => (preview.project.lifecycle_version))));
      const counts = node("dl", "admin-count-grid");
      for (const [key, label] of fields) {
        const row = node("div"); const value = node("dd", "", () => numberText(preview.counts[key]));
        value.dataset.count = key; appendOwned(row, () => (node("dt", "", () => (label))), () => (value)); appendOwned(counts, () => (row));
      }
      $("admin-delete-counts").replaceChildren(counts);
      setText($("admin-delete-status"), () => (tr("Inventory received from the server. Enter the exact ID above to send a single deletion request. The server will reject it if the version changes.")));
    } catch (error) {
      if (validTarget()) {
        state.adminDelete = null;
        setText($("admin-delete-status"), () => (tr("Inventory was not confirmed. Deletion is unavailable. {0} Close this dialog before requesting a new inventory.", () => (errorText(error)))));
      } else if (current(context) && error.status === 403) showError(error, "admin-error");
    } finally {
      if (validTarget()) { state.adminDeleteLoading = false; updateAdminControls(); }
    }
  }

  async function deleteProject(event) {
    event.preventDefault(); updateDeleteControls();
    const target = state.adminDelete;
    if (!target || $("admin-delete-submit").disabled || !$("admin-delete-form").reportValidity()) return;
    // Consume this preview before sending. Neither a failure nor a second click can reuse it.
    const projectId = target.id, epoch = target.epoch;
    const body = {confirm_id: projectId, expected_version: target.version};
    state.adminDelete = null; state.adminDeleteSubmitting = true;
    $("admin-delete-confirm").value = "";
    setText($("admin-delete-status"), () => (tr("Sending a single deletion request. Closing this dialog will not cancel a request already sent. No automatic retry.")));
    updateDeleteControls();
    try {
      await adminMutation(`/v1/admin/projects/${pathId(projectId)}`, "DELETE", body,
        tr("Project {0} and its contents were deleted from the Agent Mesh server. Accounts and keys remain. Backups and copies held by agents were not deleted; project and channel IDs cannot be reused.", () => (projectId)),
        (result) => {
          if (result.deleted !== true || result.project_id !== projectId) throw new Error("Invalid deletion response");
          forgetProjectContent(projectId);
          const channelIds = new Set(list(state.admin.channels).filter((channel) => channel.project_id === projectId).map((channel) => channel.id));
          state.admin.projects = list(state.admin.projects).filter((project) => project.id !== projectId);
          state.admin.channels = list(state.admin.channels).filter((channel) => channel.project_id !== projectId);
          state.admin.project_members = list(state.admin.project_members).filter((member) => member.project_id !== projectId);
          state.admin.channel_members = list(state.admin.channel_members).filter((member) => !channelIds.has(member.channel_id));
          state.admin.deliveries = list(state.admin.deliveries).filter((delivery) => !channelIds.has(delivery.channel_id));
          if (epoch === state.adminDeleteEpoch) clearAdminDelete();
          renderAdmin(); renderNavigation();
        },
        (_error, message) => {
          if (epoch === state.adminDeleteEpoch && $("admin-delete-dialog").open) setText($("admin-delete-status"), () => (tr("{0} This deletion inventory is no longer usable. Close this dialog and obtain a new inventory before confirming.", () => (message))));
        });
    } finally {
      if (epoch === state.adminDeleteEpoch) { state.adminDeleteSubmitting = false; updateAdminControls(); }
    }
  }

  function renderAdmin() {
    if (!isOwner() || !state.admin) return;
    const principals = list(state.admin.principals);
    setText($("admin-principal-count"), () => (tr("{0} accounts", () => (principals.length))));
    replaceContent("admin-principal-list", ...principals.map((principal) => {
      const card = node("article", "admin-principal"); card.dataset.principalId = principal.id;
      const heading = node("div", "heading-row");
      const title = node("h4", "", () => (principal.name || principal.id));
      const key = node("span", "admin-key-state", () => (principal.key_active === true ? tr("Key active") : tr("Key inactive")));
      key.dataset.active = String(principal.key_active === true); appendOwned(heading, () => (title), () => (key));
      appendOwned(card, () => (heading), () => (node("p", "field-help", () => (`${principal.id} · ${principal.kind}${principal.runtime ? ` · ${principal.runtime}` : ""}`))));
      if (principal.kind === "agent") {
        const labels = {fresh: tr("Fresh heartbeat"), stale: tr("Stale heartbeat"), unknown: tr("Heartbeat unknown")};
        appendOwned(card, () => (node("p", "field-help", () => (formatText([""," · ",""], () => (labels[principal.freshness] || labels.unknown), () => (dateText(principal.last_seen_at)))))));
        if (principal.activity) appendOwned(card, () => (node("p", "field-help", () => (tr("Self-report: {0}", () => (principal.activity))))));
        if (principal.session_id) appendOwned(card, () => (node("p", "field-help", () => (tr("Adapter session: {0}", () => (principal.session_id))))));
      } else appendOwned(card, () => (node("p", "field-help", () => (tr("Not an agent · heartbeat is not used")))));
      if (principal.kind === "owner") {
        appendOwned(card, () => (node("p", "field-help", () => (tr("Owner. This account and its key can only be managed through the local CLI.")))));
      } else if (["agent", "viewer"].includes(principal.kind)) {
        const actions = node("div", "admin-actions");
        for (const [action, label] of [["rotate-key", principal.key_active === true ? tr("Rotate key…") : tr("Issue key…")], ["revoke-key", tr("Revoke key…")]]) {
          const button = node("button", action === "revoke-key" ? "secondary-button danger-button" : "secondary-button", () => (label));
          button.type = "button"; button.dataset.adminAction = action; button.dataset.principalId = principal.id;
          button.dataset.focusKey = `principal-action:${principal.id}:${action}`;
          button.addEventListener("click", () => void adminKeyAction(principal, action)); appendOwned(actions, () => (button));
        }
        appendOwned(card, () => (actions));
      }
      return card;
    }));
    if (!principals.length) appendOwned($("admin-principal-list"), () => (node("p", "empty-state", () => (tr("No accounts received.")))));
    renderAdminProjects();
    adminOptions("admin-channel-project", activeAdminProjects(), tr("Select an active project"));
    adminOptions("admin-access-agent", principals.filter((principal) => ["agent", "viewer"].includes(principal.kind)), tr("Select an account"));
    adminOptions("admin-access-project", activeAdminProjects(), tr("Select an active project"));
    updateAccessChannels();
    replaceContent("admin-audit-list", ...list(state.admin.audit).slice(0, 100).map((entry) => {
      const row = node("article", "admin-record");
      appendOwned(row, () => (node("h4", "", () => (entry.action))), () => (node("p", "field-help", () => (tr("{0} · actor: {1}\n{2}: {3} · record {4}", () => (dateText(entry.created_at)), () => (entry.actor_id || tr("local CLI")), () => (entry.target_type), () => (entry.target_id), () => (entry.id))))));
      // The API allowlists metadata; still render only plain text, never markup.
      if (entry.details && typeof entry.details === "object") appendOwned(row, () => (node("pre", "admin-metadata", () => (JSON.stringify(entry.details, null, 2)))));
      return row;
    }));
    if (!list(state.admin.audit).length) appendOwned($("admin-audit-list"), () => (node("p", "empty-state", () => (tr("No administrative actions in this snapshot.")))));
    $("admin-audit-truncated").hidden = !state.admin.auditTruncated;
    replaceContent("admin-delivery-list", ...list(state.admin.deliveries).slice(0, 100).map((delivery) => {
      const row = node("article", "admin-record");
      appendOwned(row, () => (node("h4", "", () => (delivery.uncertain_at ? tr("Uncertain delivery") : tr("Awaiting acceptance")))), () => (node("p", "field-help", () => (tr("Message: {0}\nChannel: {1}\nAuthor: {2} → Recipient: {3}", () => (delivery.message_id), () => (delivery.channel_id), () => (delivery.author_id), () => (delivery.recipient_id))))), () => (node("p", "field-help", () => (tr("Stored: {0}\nDelivered: {1}\nAccepted: {2}\nUncertain: {3}", () => (dateText(delivery.created_at)), () => (dateText(delivery.delivered_at)), () => (dateText(delivery.accepted_at)), () => (dateText(delivery.uncertain_at)))))));
      return row;
    }));
    if (!list(state.admin.deliveries).length) appendOwned($("admin-delivery-list"), () => (node("p", "empty-state", () => (tr("No pending or uncertain deliveries in this snapshot.")))));
    $("admin-delivery-truncated").hidden = !state.admin.deliveriesTruncated;
    renderOnboarding();
    updateAdminControls();
  }

  async function selectAdmin() {
    if (!isOwner() || state.adminBusy) return;
    stopNetwork(); clearDrafts(); clearError(); setView("admin");
    await refresh();
  }

  async function loadAdmin(background = false) {
    if (!isOwner() || state.view !== "admin") return false;
    if (state.adminLoading || state.adminBusy) { state.refreshAgain = true; return false; }
    const context = state.context;
    const readSeq = ++state.adminReadSeq, writeVersion = state.adminWriteVersion;
    state.adminLoading = true; state.adminLoadBackground = background && Boolean(state.admin);
    if (!state.adminLoadBackground) { updateAdminControls(); connection(tr("Loading the administrative snapshot…")); }
    try {
      const [overview, audit, deliveries, onboarding] = await Promise.all([
        api("/v1/admin/overview"), api("/v1/admin/audit?limit=100"), api("/v1/admin/deliveries?limit=100"),
        api("/v1/admin/onboarding").catch(error => { if (error.status === 404) return {enabled: false, invitations: []}; throw error; }),
      ]);
      if (!current(context) || state.view !== "admin" || readSeq !== state.adminReadSeq || writeVersion !== state.adminWriteVersion) return false;
      if (!Array.isArray(overview.principals) || !Array.isArray(overview.projects) || !Array.isArray(overview.channels)) throw new Error("Invalid admin overview");
      state.admin = {...overview, audit: list(audit.entries), auditTruncated: audit.truncated === true,
        deliveries: list(deliveries.deliveries), deliveriesTruncated: deliveries.truncated === true};
      state.onboarding = onboarding;
      state.projects = activeAdminProjects();
      if (state.project) {
        const selected = list(overview.projects).find((project) => project.id === state.project.id);
        if (selected) state.project = selected;
        else forgetProjectContent(state.project.id);
      }
      renderAdmin(); renderNavigation();
      if (!background) clearError("admin-error");
      state.lastSync = Date.now(); state.syncError = false; renderConnection();
      return true;
    } catch (error) {
      if (!current(context) || state.view !== "admin" || readSeq !== state.adminReadSeq || writeVersion !== state.adminWriteVersion) return false;
      if (error.status === 403 || error.status === 404) {
        clearAdminData();
        setText($("updated-at"), () => (""));
      }
      showError(error, "admin-error");
      state.syncError = true; renderConnection(); return false;
    } finally {
      if (current(context) && state.view === "admin" && readSeq === state.adminReadSeq) {
        state.adminLoading = false; state.adminLoadBackground = false; updateAdminControls();
      }
    }
  }

  function validAdminForm(id) {
    const form = $(id);
    for (const input of form.querySelectorAll("input[data-max-bytes]")) {
      const value = input.value.trim(), max = Number(input.dataset.maxBytes);
      setOwnedValidity(input, () => (value.includes("\0") ? tr("Null characters are not allowed.") :
        utf8.encode(value).length > max ? tr("Maximum {0} UTF-8 bytes.", () => (max)) :
        (input.required || input.value) && !value ? tr("Enter text, not just whitespace.") : ""));
    }
    return form.reportValidity();
  }

  async function adminMutation(path, method, body, success, onSuccess, onFailure) {
    if (!isOwner() || !state.admin || state.adminBusy || blockingAdminLoad() || state.view !== "admin") return;
    const context = state.context;
    state.adminWriteVersion += 1; state.adminReadSeq += 1;
    state.adminLoading = false; state.adminLoadBackground = false;
    clearAdminKey(); clearError("admin-error"); state.adminBusy = true;
    setText($("admin-status"), () => (tr("Waiting for server confirmation. The request is not retried automatically…")));
    updateAdminControls(); renderNavigation();
    let confirmed = false;
    try {
      const result = await api(path, {method, body});
      if (!current(context) || !isOwner() || state.view !== "admin") return;
      if (onSuccess) onSuccess(result);
      confirmed = true;
      setText($("admin-status"), () => (success));
    } catch (error) {
      if (!current(context) || state.view !== "admin") return;
      clearAdminKey();
      const knownFailure = error instanceof ApiError && error.status < 500;
      const message = knownFailure
        ? error.status === 409 ? tr("API 409: the ID is occupied (including after deletion), the project version changed, or its state does not permit this action. Refresh the snapshot and check the project and permissions.")
          : errorText(error)
        : method === "DELETE" ? tr("Deletion outcome unknown: server confirmation was not received. The request will not be retried. Close this dialog, refresh the project list and check the audit log. A new deletion requires a fresh inventory and entering the ID again.")
          : tr("Change outcome unknown: the server response was not received. No automatic retry. Refresh the snapshot and check the audit log before another explicit action. If the response containing a key was lost, that key cannot be retrieved again; another rotation requires separate confirmation.");
      setText($("admin-error"), message);
      $("admin-error").hidden = false; setText($("admin-status"), () => (tr("The change was not confirmed by this tab.")));
      if (onFailure) onFailure(error, message);
    } finally {
      if (current(context) && state.view === "admin") {
        state.adminBusy = false; updateAdminControls(); renderNavigation();
        if (confirmed) await loadAdmin();
        if (state.refreshAgain) scheduleRefresh();
      }
    }
  }

  const ONBOARDING_DOCUMENTS = ["PROMPT.md", "SKILL.md", "HOOKS-AND-TOOLS.md"];

  function clearOnboardingGuidance(area) {
    state.onboardingGuidance[area] = null;
    for (const [url, owner] of state.onboardingGuideURLs) if (owner === area) {
      URL.revokeObjectURL(url); state.onboardingGuideURLs.delete(url);
    }
    $("admin-onboarding-" + area + "-files").replaceChildren();
    setText($("admin-onboarding-" + area + "-status"), "");
  }

  function onboardingGuidanceFiles(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "files,version" ||
        value.version !== 1 || !Array.isArray(value.files) || value.files.length !== 3) throw new Error("Invalid guidance");
    const files = value.files.map(file => {
      if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).sort().join(",") !== "content,name,sha256" ||
          !ONBOARDING_DOCUMENTS.includes(file.name) || typeof file.content !== "string" || !file.content || file.content.includes("\0") ||
          utf8.encode(file.content).length > 32768 || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid guidance file");
      return {name: file.name, content: file.content, sha256: file.sha256};
    });
    if (new Set(files.map(file => file.name)).size !== 3) throw new Error("Duplicate guidance file");
    return ONBOARDING_DOCUMENTS.map(name => files.find(file => file.name === name));
  }

  function onboardingGuidanceCurrent(area, slot, context = state.context, auth = state.authVersion) {
    return current(context) && auth === state.authVersion && isOwner() && state.view === "admin" && state.onboardingGuidance[area] === slot &&
      (area !== "result" || $("admin-onboarding-dialog").open && slot.version === state.onboardingVersion);
  }

  async function loadOnboardingGuidance(area, value) {
    if (!isOwner() || state.view !== "admin") { clearOnboardingGuidance(area); return; }
    let files, problem = "";
    try { files = onboardingGuidanceFiles(value); }
    catch { files = []; problem = value == null ? "unavailable" : "invalid"; }
    const signature = problem || JSON.stringify(files);
    const previous = state.onboardingGuidance[area];
    if (previous?.signature === signature && (previous.files.length || previous.problem || previous.context === state.context && previous.auth === state.authVersion)) return;
    clearOnboardingGuidance(area);
    const slot = {signature, files: [], version: state.onboardingVersion, seq: ++state.onboardingGuideSeq, problem,
      context: state.context, auth: state.authVersion};
    state.onboardingGuidance[area] = slot;
    const status = $("admin-onboarding-" + area + "-status"), context = state.context, auth = state.authVersion;
    if (problem) {
      setText(status, () => problem === "unavailable" ? tr("Guide files are unavailable from this server. You can still use the connection command.") :
        tr("Guide files failed validation. Copying and downloading them are unavailable; the connection command is separate."));
      return;
    }
    setText(status, () => tr("Checking guide files…"));
    try {
      for (const file of files) if (await digest(utf8.encode(file.content)) !== file.sha256) throw new Error("Guidance hash mismatch");
      if (!onboardingGuidanceCurrent(area, slot, context, auth)) return;
      slot.files = files;
      renderOnboardingGuidance(area, slot);
      setText(status, () => tr("English originals · SHA-256 checked against API metadata."));
    } catch {
      if (onboardingGuidanceCurrent(area, slot, context, auth)) {
        slot.problem = "invalid";
        setText(status, () => tr("Guide files failed validation. Copying and downloading them are unavailable; the connection command is separate."));
      }
    }
  }

  function renderOnboardingGuidance(area, slot) {
    const labels = [tr("Start prompt"), tr("Optional skill"), tr("Hooks and tools")];
    const descriptions = [tr("Loaded automatically when the connection starts a new CLI session."),
      tr("Install manually only if useful; see the installation locations in HOOKS-AND-TOOLS.md."),
      tr("Setup, inbox polling and delivery reports. Hooks and MCP are configured for each launch.")];
    replaceContent("admin-onboarding-" + area + "-files", ...slot.files.map((file, index) => {
      const details = node("details", "onboarding-document"), summary = node("summary");
      details.dataset.guidanceFile = file.name;
      appendOwned(summary, () => node("span", "", labels[index]), () => node("code", "", file.name));
      const text = node("textarea"); text.readOnly = true; text.spellcheck = false; text.rows = 9; text.value = file.content;
      text.id = `onboarding-${area}-document-${index}`; text.lang = "en";
      text.setAttribute("aria-label", file.name);
      const actions = node("div", "dialog-actions");
      for (const [action, label] of [["copy", tr("Copy text")], ["download", tr("Download {0}", file.name)]]) {
        const button = node("button", "secondary-button", label); button.type = "button"; button.dataset.guidanceAction = action;
        button.addEventListener("click", () => action === "copy" ? void copyOnboardingDocument(area, file.name) : downloadOnboardingDocument(area, file.name));
        appendOwned(actions, () => button);
      }
      appendOwned(details, () => summary, () => node("p", "field-help", descriptions[index]), () => text, () => actions);
      return details;
    }));
  }

  async function copyOnboardingDocument(area, name) {
    const slot = state.onboardingGuidance[area], file = slot?.files.find(item => item.name === name);
    if (!file || !onboardingGuidanceCurrent(area, slot)) return;
    const context = state.context, auth = state.authVersion;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(file.content);
      if (onboardingGuidanceCurrent(area, slot, context, auth)) setText($("admin-onboarding-" + area + "-status"), () => tr("Copied {0}. No connection command was included.", name));
    } catch {
      if (!onboardingGuidanceCurrent(area, slot, context, auth)) return;
      const text = $(`onboarding-${area}-document-${ONBOARDING_DOCUMENTS.indexOf(name)}`);
      text.focus(); text.select();
      setText($("admin-onboarding-" + area + "-status"), () => tr("Automatic copying is unavailable. Copy the selected document manually."));
    }
  }

  function downloadOnboardingDocument(area, name) {
    const slot = state.onboardingGuidance[area], file = slot?.files.find(item => item.name === name);
    if (!file || !onboardingGuidanceCurrent(area, slot)) return;
    const url = URL.createObjectURL(new Blob([file.content], {type: "text/markdown;charset=utf-8"}));
    state.onboardingGuideURLs.set(url, area);
    const link = node("a"); link.href = url; link.download = file.name; appendOwned(document.body, () => link); link.click(); link.remove();
    setTimeout(() => { URL.revokeObjectURL(url); state.onboardingGuideURLs.delete(url); }, 1000);
  }

  function renderOnboardingScope(invitation) {
    const validID = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
    if (!invitation || !validID(invitation.agent_id) || !validID(invitation.project_id) ||
        !Array.isArray(invitation.channel_ids) || !invitation.channel_ids.length || invitation.channel_ids.length > 8 ||
        !invitation.channel_ids.every(validID) || new Set(invitation.channel_ids).size !== invitation.channel_ids.length ||
        !["auto", "codex", "claude"].includes(invitation.runtime)) throw new Error("Invalid invitation scope");
    const name = typeof invitation.agent_name === "string" && utf8.encode(invitation.agent_name).length <= 200 ? invitation.agent_name : "";
    const rows = [[tr("Agent"), name && name !== invitation.agent_id ? `${name} (${invitation.agent_id})` : invitation.agent_id], [tr("Project"), invitation.project_id], [tr("Channels"), invitation.channel_ids.join(", ")],
      [tr("Requested CLI"), invitation.runtime === "auto" ? tr("Auto · chosen locally on first run") : invitation.runtime === "claude" ? "Claude Code" : "Codex"]];
    replaceContent("admin-onboarding-scope", ...rows.flatMap(([label, value]) => [node("dt", "", label), node("dd", "", value)]));
  }

  function clearOnboardingResult() {
    state.onboardingCommand = ""; state.onboardingVersion += 1;
    clearOnboardingGuidance("result");
    $("admin-onboarding-scope").replaceChildren();
    $("admin-onboarding-result-guide").open = false;
    $("admin-onboarding-command").value = "";
    setText($("admin-onboarding-target"), () => (""));
    setText($("admin-onboarding-copy-status"), () => (""));
    $("admin-onboarding-repository").removeAttribute("href");
    if (state.onboardingDownload) { URL.revokeObjectURL(state.onboardingDownload); state.onboardingDownload = ""; }
    if ($("admin-onboarding-dialog").open) $("admin-onboarding-dialog").close();
  }

  const selectedOnboardingChannels = () => [...$("admin-onboarding-channels").querySelectorAll("input:checked")].map(input => input.value);

  function renderOnboardingChannels(reset = false) {
    const selected = new Set(reset ? [] : selectedOnboardingChannels());
    const projectId = $("admin-onboarding-project").value;
    const channels = list(state.admin?.channels).filter(channel => channel.project_id === projectId);
    replaceContent("admin-onboarding-channels", ...channels.map(channel => {
      const label = node("label", "onboarding-channel"), input = node("input"), text = node("span", "", () => (`${channel.name} (${channel.id})`));
      input.type = "checkbox"; input.value = channel.id; input.checked = selected.has(channel.id);
      input.dataset.focusKey = `onboarding-channel:${channel.id}`;
      input.addEventListener("change", updateAdminControls);
      appendOwned(label, () => input, () => text); return label;
    }));
    if (!channels.length) appendOwned($("admin-onboarding-channels"), () => node("p", "field-help", () => tr("Select a project with an available communication channel.")));
  }

  function updateOnboardingControls(unavailable) {
    const disabled = unavailable || state.onboarding?.enabled !== true;
    for (const control of $("admin-onboarding-form").querySelectorAll("input,select,button")) control.disabled = disabled;
    const selected = selectedOnboardingChannels();
    for (const input of $("admin-onboarding-channels").querySelectorAll("input")) input.disabled = disabled || (!input.checked && selected.length >= 8);
    $("admin-onboarding-submit").disabled = disabled || !$("admin-onboarding-project").value || !selected.length || selected.length > 8;
    for (const button of $("admin-onboarding-list").querySelectorAll("button")) button.disabled = unavailable || (button.dataset.onboardingAction === "reissue" && disabled);
    setText($("admin-onboarding-summary"), () => selected.length
      ? tr("Read and write: {0} channel(s). The connector starts in an empty folder on the agent’s computer.", () => selected.length)
      : tr("Select 1 to 8 channels for the new agent."));
  }

  function renderOnboarding() {
    const config = state.onboarding;
    void loadOnboardingGuidance("guide", config?.guidance);
    setText($("admin-onboarding-availability"), () => config?.enabled === true
      ? tr("Connection address: {0}", () => config.public_url)
      : tr("Connection generation is unavailable. Configure the server’s public HTTPS address and CA certificate."));
    adminOptions("admin-onboarding-project", activeAdminProjects(), tr("Select an active project"));
    if (!$("admin-onboarding-project").value) {
      const projects = activeAdminProjects();
      if (projects.some(project => project.id === state.project?.id)) $("admin-onboarding-project").value = state.project.id;
      else if (projects.length === 1) $("admin-onboarding-project").value = projects[0].id;
    }
    renderOnboardingChannels();
    const labels = {pending: tr("Awaiting connection"), claimed: tr("Key issued"), expired: tr("Expired"), revoked: tr("Revoked")};
    replaceContent("admin-onboarding-list", ...list(config?.invitations).map(invite => {
      const row = node("article", "admin-record"); row.dataset.invitationId = invite.id;
      appendOwned(row, () => node("h4", "", () => invite.agent_id),
        () => node("p", "field-help", () => tr("{0} · {1} · expires {2}", () => labels[invite.status] || invite.status, () => invite.runtime, () => dateText(invite.expires_at))),
        () => node("p", "field-help", () => `${invite.project_id} · ${list(invite.channel_ids).join(", ")}`));
      const inactive = list(state.admin?.principals).some(principal => principal.id === invite.agent_id && principal.kind === "agent" && principal.key_active !== true);
      const actions = node("div", "admin-actions");
      for (const [action, label] of [["reissue", tr("New command…")], ["revoke", tr("Revoke invitation…")]]) {
        if (action === "revoke" ? invite.status !== "pending" : !inactive) continue;
        const button = node("button", "secondary-button", () => label); button.type = "button"; button.dataset.onboardingAction = action;
        button.dataset.focusKey = `onboarding:${invite.id}:${action}`;
        button.addEventListener("click", () => void onboardingAction(invite, action)); appendOwned(actions, () => button);
      }
      appendOwned(row, () => actions); return row;
    }));
    if (!list(config?.invitations).length) appendOwned($("admin-onboarding-list"), () => node("p", "field-help", () => tr("No invitations yet.")));
    $("admin-onboarding-truncated").hidden = config?.truncated !== true;
  }

  function showOnboardingResult(result) {
    const origin = new URL(result.public_url), repository = new URL(result.repository);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
        repository.protocol !== "https:" || repository.username || repository.password ||
        !/^sha256\/\/[A-Za-z0-9+/]{43}=$/.test(result.spki_pin) || !/^[a-f0-9]{64}$/.test(result.token) ||
        !result.invitation?.agent_id || !result.invitation?.expires_at) throw new Error("Invalid onboarding response");
    renderOnboardingScope(result.invitation);
    const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
    const pipeline = 'curl --disable -fkSs --noproxy "*" --proto "=https" --connect-timeout 10 --max-time 60 --pinnedpubkey "$2" "$1/connect/install.sh" | bash -s -- "$@"';
    state.onboardingCommand = `bash -o pipefail -c ${quote(pipeline)} mesh-connect ${quote(origin.origin)} ${quote(result.spki_pin)} ${quote(result.token)}`;
    $("admin-onboarding-command").value = state.onboardingCommand;
    $("admin-onboarding-repository").href = repository.href;
    const {agent_id: agentId, expires_at: expiresAt} = result.invitation;
    setText($("admin-onboarding-target"), () => tr("Agent {0}. Use once before {1}.", () => agentId, () => dateText(expiresAt)));
    $("admin-onboarding-dialog").showModal(); $("admin-onboarding-copy").focus();
    void loadOnboardingGuidance("result", result.guidance);
  }

  async function onboardingAction(invite, action) {
    if (!isOwner() || state.adminBusy || blockingAdminLoad() || !["reissue", "revoke"].includes(action)) return;
    const question = action === "reissue"
      ? tr("Generate a new command for {0}? Previous unused invitations for this agent will stop working. Lifetime: {1} hours.", () => invite.agent_id, () => $("admin-onboarding-expiry").value)
      : tr("Revoke the unused invitation for {0}? The account and its configured permissions will remain.", () => invite.agent_id);
    if (!window.confirm(question)) return;
    await adminMutation(`/v1/admin/onboarding/${pathId(invite.id)}/${action}`, "POST", action === "reissue" ? {expires_in_hours: Number($("admin-onboarding-expiry").value)} : {},
      action === "reissue" ? tr("New connection command generated.") : tr("Invitation revoked."), action === "reissue" ? showOnboardingResult : undefined);
  }

  async function adminKeyAction(principal, action) {
    if (!isOwner() || !["agent", "viewer"].includes(principal.kind) || state.adminBusy || blockingAdminLoad()) return;
    const rotate = action === "rotate-key";
    const warning = rotate
      ? tr("Issue a new key for “{0}” ({1})? The old key will stop working immediately. The new key will be shown only once. History and the ID will be preserved.", () => (principal.name), () => (principal.id))
      : tr("Revoke the key for “{0}” ({1})? Agent Mesh access and existing SSE connections will end. The external CLI will not be stopped, and work already dispatched will not be cancelled.", () => (principal.name), () => (principal.id));
    if (!window.confirm(warning)) return;
    await adminMutation(`/v1/admin/principals/${pathId(principal.id)}/${action}`, "POST", {},
      rotate ? tr("Key for {0} rotated. The new secret is shown once.", () => (principal.id)) : tr("Key for {0} revoked. Account history and permissions are preserved.", () => (principal.id)),
      (result) => {
        if (!rotate) return;
        if (result.agent_id !== principal.id || typeof result.key !== "string" || !result.key || result.key.length > 1024) throw new Error("Invalid one-time key response");
        state.adminKey = result.key;
        $("admin-issued-key").value = state.adminKey;
        setText($("admin-key-target"), () => (tr("Account: {0} ({1}).", () => (principal.name), () => (principal.id))));
        $("admin-key-dialog").showModal(); $("admin-key-close").focus();
      });
  }

  $("nav-overview").addEventListener("click", () => void selectOverview());
  $("nav-project-native").addEventListener("click", () => void selectProjectNative());
  $("nav-project-map").addEventListener("click", () => void selectProjectMap());
  for (const button of $("project-map-schema").querySelectorAll("[data-map-type]")) button.addEventListener("click", () => selectMapType(button.dataset.mapType, true));
  $("project-map-type").addEventListener("change", () => selectMapType($("project-map-type").value));
  $("project-map-search").addEventListener("input", () => { if (state.projectMap) { state.projectMap.query = $("project-map-search").value; renderProjectMap(); } });
  $("project-map-admin").addEventListener("click", () => { if (isOwner()) void selectAdmin(); });
  $("native-open-project").addEventListener("click", () => void selectProjectNative(state.channel?.id || ""));
  for (const id of ["project-native-actor", "project-native-channel"]) $(id).addEventListener("change", () => void changeProjectNativeFilter());
  $("project-native-more").addEventListener("click", () => {
    const data = state.projectNative;
    if (state.view !== "project-native" || !data?.ready || data.loading || data.error || !data.hasMore || data.rows.length >= PROJECT_NATIVE_MAX) return;
    data.pages = 2; data.loading = true; renderProjectNative(); scheduleRefresh();
  });
  $("sidebar-toggle").addEventListener("click", () => setNavigationOpen(!document.body.classList.contains("nav-open")));
  $("navigation").addEventListener("click", (event) => { if (event.target.closest("button:not(:disabled)")) setNavigationOpen(false); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("nav-open")) { setNavigationOpen(false); $("sidebar-toggle").focus(); }
  });
  for (const button of document.querySelectorAll("[data-open-view]")) button.addEventListener("click", () => void selectCoordination(button.dataset.openView));
  for (const button of document.querySelectorAll("[data-overview-target]")) button.addEventListener("click", () => {
    const target = $(button.dataset.overviewTarget); target.scrollIntoView({block: "center"}); target.focus({preventScroll: true});
  });
  for (const button of $("admin-section-nav").querySelectorAll("button")) button.addEventListener("click", () => {
    setAdminSection(button.dataset.adminSection);
    if (button.dataset.adminSection === "delivery-alerts") { renderDeliveryAlerts(); void loadDeliveryAlerts(); scheduleDeliveryPoll(); }
  });
  $("delivery-alert-open").addEventListener("click", () => void selectDeliveryAlerts());
  $("delivery-policy-form").addEventListener("submit", saveDeliveryPolicy);
  for (const id of ["delivery-policy-enabled", "delivery-policy-ack", "delivery-policy-reply-enabled", "delivery-policy-reply"]) $(id).addEventListener("input", captureDeliveryDraft);
  $("delivery-policy-reload").addEventListener("click", () => void reloadDeliveryPolicy());
  $("delivery-alert-refresh").addEventListener("click", () => { void loadDeliveryAlerts(); scheduleDeliveryPoll(); });
  $("delivery-alert-more").addEventListener("click", () => void loadDeliveryAlerts({more: true}));
  setAdminSection("accounts");
  $("nav-admin").addEventListener("click", () => { if (state.view !== "admin") void selectAdmin(); });
  $("nav-connect-agent").addEventListener("click", () => { setAdminSection("onboarding"); if (state.view !== "admin") void selectAdmin(); });
  $("nav-unread").addEventListener("click", () => { setNavigationOpen(false); void openNextUnread(); });
  $("message-list").addEventListener("scroll", scheduleChannelRead, {passive: true});
  for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("close", scheduleChannelRead);
  $("admin-onboarding-project").addEventListener("change", () => { renderOnboardingChannels(true); updateAdminControls(); });
  $("admin-onboarding-form").addEventListener("submit", event => {
    event.preventDefault();
    if ($("admin-onboarding-submit").disabled || !validAdminForm("admin-onboarding-form")) return;
    const body = {id: $("admin-onboarding-id").value.trim(), name: $("admin-onboarding-name").value.trim(),
      project_id: $("admin-onboarding-project").value, channel_ids: selectedOnboardingChannels(),
      runtime: $("admin-onboarding-runtime").value, expires_in_hours: Number($("admin-onboarding-expiry").value)};
    void adminMutation("/v1/admin/onboarding", "POST", body, tr("Agent created. Copy the connection command shown once."), result => {
      showOnboardingResult(result); $("admin-onboarding-id").value = ""; $("admin-onboarding-name").value = "";
    });
  });
  $("admin-onboarding-close").addEventListener("click", clearOnboardingResult);
  $("admin-onboarding-dialog").addEventListener("cancel", event => { event.preventDefault(); clearOnboardingResult(); });
  $("admin-onboarding-dialog").addEventListener("close", () => { if (!$("admin-onboarding-dialog").open) clearOnboardingResult(); });
  $("admin-onboarding-copy").addEventListener("click", async () => {
    if (!isOwner() || !state.onboardingCommand || !$("admin-onboarding-dialog").open) return;
    const version = state.onboardingVersion;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(state.onboardingCommand);
      if (version === state.onboardingVersion && state.onboardingCommand) setText($("admin-onboarding-copy-status"), () => tr("Command copied. Share it only with this agent."));
    } catch {
      if (version !== state.onboardingVersion || !state.onboardingCommand) return;
      $("admin-onboarding-command").focus(); $("admin-onboarding-command").select();
      setText($("admin-onboarding-copy-status"), () => tr("Automatic copying is unavailable. Copy the selected command manually."));
    }
  });
  $("admin-onboarding-download").addEventListener("click", () => {
    if (!isOwner() || !state.onboardingCommand || !$("admin-onboarding-dialog").open) return;
    if (state.onboardingDownload) URL.revokeObjectURL(state.onboardingDownload);
    const url = URL.createObjectURL(new Blob(["#!/usr/bin/env bash\nset -euo pipefail\n" + state.onboardingCommand + "\n"], {type: "text/x-shellscript"}));
    state.onboardingDownload = url;
    const link = node("a"); link.href = url; link.download = "connect.sh"; appendOwned(document.body, () => link); link.click(); link.remove();
    setTimeout(() => { URL.revokeObjectURL(url); if (state.onboardingDownload === url) state.onboardingDownload = ""; }, 1000);
  });
  for (const id of ["admin-principal-form", "admin-project-form", "admin-channel-form", "admin-onboarding-form"]) {
    $(id).addEventListener("input", (event) => { if (event.target instanceof HTMLInputElement) setOwnedValidity(event.target, () => ("")); });
  }
  $("admin-principal-form").addEventListener("submit", (event) => {
    event.preventDefault(); if (!validAdminForm("admin-principal-form")) return;
    const body = {id: $("admin-principal-id").value.trim(), name: $("admin-principal-name").value.trim(), kind: $("admin-principal-kind").value, runtime: $("admin-principal-runtime").value.trim()};
    if (!["agent", "viewer"].includes(body.kind)) return;
    void adminMutation("/v1/admin/principals", "POST", body, tr("Account {0} created without a key or permissions. Grant project access, then channel access; issue a key separately.", () => (body.id)), () => $("admin-principal-form").reset());
  });
  $("admin-project-form").addEventListener("submit", (event) => {
    event.preventDefault(); if (!validAdminForm("admin-project-form")) return;
    const body = {id: $("admin-project-id").value.trim(), name: $("admin-project-name").value.trim()};
    void adminMutation("/v1/admin/projects", "POST", body, tr("Project {0} created. Participant access was not granted automatically.", () => (body.id)), () => $("admin-project-form").reset());
  });
  $("admin-channel-form").addEventListener("submit", (event) => {
    event.preventDefault(); if (!validAdminForm("admin-channel-form")) return;
    const body = {id: $("admin-channel-id").value.trim(), name: $("admin-channel-name").value.trim(), project_id: $("admin-channel-project").value};
    if (!activeAdminProjects().some((project) => project.id === body.project_id)) return;
    void adminMutation("/v1/admin/channels", "POST", body, tr("Channel {0} created in project {1}. Channel access must be granted separately.", () => (body.id), () => (body.project_id)), () => $("admin-channel-form").reset());
  });
  for (const id of ["admin-access-agent", "admin-access-project", "admin-access-scope", "admin-access-channel"]) $(id).addEventListener("change", () => {
    if (id === "admin-access-project") updateAccessChannels();
    syncAccessLevel(); updateAdminControls();
  });
  $("admin-access-level").addEventListener("change", updateAdminControls);
  $("admin-access-form").addEventListener("submit", (event) => {
    event.preventDefault(); updateAdminControls();
    if ($("admin-access-submit").disabled || !$("admin-access-form").reportValidity()) return;
    const scope = $("admin-access-scope").value, access = $("admin-access-level").value;
    const body = {agent_id: $("admin-access-agent").value, scope, resource_id: $(scope === "project" ? "admin-access-project" : "admin-access-channel").value, access};
    const level = {none: tr("no access"), read: tr("read"), write: tr("read and write")}[access];
    const warning = scope === "project" && access === "none" ? tr(" All this account’s permissions for the project’s channels will also be removed.") : "";
    if (!window.confirm(tr("Change access for {0}: {1} {2} → {3}?{4}", () => (body.agent_id), () => (scope === "project" ? tr("project") : tr("channel")), () => (body.resource_id), () => (level), () => (warning)))) return;
    void adminMutation("/v1/admin/access", "PUT", body, tr("Access for {0} to {1}: {2}. Change confirmed by the server.", () => (body.agent_id), () => (body.resource_id), () => (level)));
  });
  $("admin-key-close").addEventListener("click", clearAdminKey);
  $("admin-delete-form").addEventListener("submit", deleteProject);
  $("admin-delete-confirm").addEventListener("input", updateDeleteControls);
  $("admin-delete-cancel").addEventListener("click", () => { clearAdminDelete(); updateAdminControls(); });
  $("admin-delete-dialog").addEventListener("cancel", (event) => { event.preventDefault(); clearAdminDelete(); updateAdminControls(); });
  $("admin-delete-dialog").addEventListener("close", () => {
    if (!$("admin-delete-dialog").open) { clearAdminDelete(); updateAdminControls(); }
  });
  $("admin-key-dialog").addEventListener("cancel", (event) => { event.preventDefault(); clearAdminKey(); });
  $("admin-key-dialog").addEventListener("close", () => { if (!$("admin-key-dialog").open) clearAdminKey(); });
  $("admin-key-copy").addEventListener("click", async () => {
    if (!isOwner() || !state.adminKey || !$("admin-key-dialog").open) return;
    const version = state.adminKeyVersion;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(state.adminKey);
      if (version === state.adminKeyVersion && state.adminKey) setText($("admin-key-copy-status"), () => (tr("Key copied to the system clipboard. Keep it secret.")));
    } catch {
      if (version !== state.adminKeyVersion || !state.adminKey) return;
      $("admin-issued-key").focus(); $("admin-issued-key").select();
      setText($("admin-key-copy-status"), () => (tr("Automatic copying is unavailable. Copy the selected key manually.")));
    }
  });

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!safeTransport || state.loginBusy || !$("login-form").reportValidity()) return;
    const entered = $("api-key").value.trim(); if (!entered) return;
    state.loginBusy = true; state.key = entered; state.authVersion += 1;
    $("api-key").value = ""; $("api-key").type = "password"; $("api-key").disabled = true;
    setText($("key-reveal"), () => (tr("Show"))); $("key-reveal").setAttribute("aria-pressed", "false");
    $("login-button").disabled = true; setText($("login-button"), () => (tr("Checking key…"))); clearError("login-error");
    const authVersion = state.authVersion;
    try {
      const identity = await api("/v1/me");
      if (!identity.agent?.id || !["agent", "viewer", "owner"].includes(identity.agent.kind)) throw new ApiError(400, tr("The API did not return a supported account."));
      const projects = await api("/v1/projects");
      if (authVersion !== state.authVersion) return;
      state.me = identity.agent; state.projects = list(projects.projects);
      document.body.classList.add("authenticated");
      $("login-panel").hidden = true; $("connected-workspace").hidden = false;
      $("navigation").hidden = false; $("logout-button").hidden = false;
      setText($("profile-name"), () => (state.me.name));
      setText($("profile-role"), () => (isOwner() ? tr("Owner · {0}", () => (state.me.id)) : isWriter() ? tr("Agent · {0}", () => (state.me.id)) : tr("Read-only · {0}", () => (state.me.id))));
      setText($("access-label"), () => (isOwner() ? tr("Owner · reads all published context") : isWriter() ? tr("Author: {0} · permissions checked by the server", () => (state.me.id)) : tr("Viewer · read-only")));
      renderNavigation(); updatePermissions();
      void startStream(authVersion); startPolling(); scheduleDeliveryPoll(0);
      if (state.projects.length) await selectProject(state.projects[0]);
      else if (isOwner()) await selectAdmin();
      else { state.dataReady = true; renderConnection(); setText($("empty-panel"), () => (tr("No available projects. New projects and granted access will appear automatically."))); }
    } catch (error) { if (authVersion === state.authVersion) lock(errorText(error)); }
    finally { state.loginBusy = false; $("login-button").disabled = !safeTransport; $("api-key").disabled = !safeTransport; setText($("login-button"), () => (tr("Connect"))); }
  });

  $("key-reveal").addEventListener("click", () => {
    const reveal = $("api-key").type === "password";
    $("api-key").type = reveal ? "text" : "password";
    setText($("key-reveal"), () => (reveal ? tr("Hide") : tr("Show")));
    $("key-reveal").setAttribute("aria-pressed", String(reveal));
  });
  $("logout-button").addEventListener("click", () => { lock(); $("api-key").focus(); });
  $("refresh-button").addEventListener("click", () => scheduleRefresh());
  for (const view of Object.keys(COORDINATION_VIEWS)) $(`nav-${view}`).addEventListener("click", () => void selectCoordination(view));
  $("task-create-form").addEventListener("submit", createTask);
  $("task-event-form").addEventListener("submit", submitTaskEvent);
  $("task-event-form").addEventListener("focusin", () => captureTaskDraft());
  $("task-event-kind").addEventListener("change", () => captureTaskDraft(true));
  $("task-event-rebase").addEventListener("click", () => { if (window.confirm(tr("Rebase the draft on the current task version? The artifact set will be replaced with the current set; the summary will be preserved."))) captureTaskDraft(true); });
  $("task-timeline-all").addEventListener("click", () => void allTaskEvents());
  $("memory-new").addEventListener("click", () => openMemoryDraft(false));
  $("memory-edit").addEventListener("click", () => openMemoryDraft(true));
  $("memory-cancel").addEventListener("click", () => { if (!state.coordinationBusy) { closeMemoryDraft(); updateCoordinationControls(); } });
  $("memory-form").addEventListener("submit", submitMemory);
  $("memory-select-current").addEventListener("click", selectMemoryContext);
  $("memory-copy-refs").addEventListener("click", async () => {
    if ($("memory-copy-refs").disabled || state.view !== "memory") return;
    const context = state.context, projectId = state.project?.id, epoch = state.coordinationEpoch;
    try { await navigator.clipboard.writeText($("memory-selected-refs").textContent); if (scopeMatches(context, projectId, epoch)) setText($("memory-selected-status"), () => (tr("References copied. Memory contents and your personal key were not copied; no run was started."))); }
    catch { if (scopeMatches(context, projectId, epoch)) setText($("memory-selected-status"), () => (tr("Clipboard unavailable. You can manually copy the displayed references after checking their versions."))); }
  });
  $("artifact-form").addEventListener("submit", uploadArtifact);
  $("artifact-more").addEventListener("click", () => {
    if (state.coordinationBusy || !state.coordination?.artifactsMore) return;
    state.coordination.artifactAfter = Math.max(0, ...state.coordination.artifacts.map((item) => number(item.seq))); scheduleRefresh();
  });
  $("nav-notes").addEventListener("click", () => { if (state.view !== "notes") void selectNotes(); });
  $("tab-chat").addEventListener("click", () => setView("chat"));
  $("tab-activity").addEventListener("click", () => setView("activity"));
  $("tab-native").addEventListener("click", () => setView("native"));
  for (const id of TECHNICAL_TOGGLES) $(id).addEventListener("change", () => {
    state.showTechnicalEvents = $(id).checked;
    for (const toggle of TECHNICAL_TOGGLES) $(toggle).checked = state.showTechnicalEvents;
    renderEvents(); renderNativeActivity(); renderProjectNative(); renderProjectMap();
  });
  for (const tab of ["chat", "activity", "native"]) $(`tab-${tab}`).addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = ["chat", "activity", "native"];
    const next = event.key === "Home" ? "chat" : event.key === "End" ? "native" : tabs[(tabs.indexOf(tab) + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length];
    setView(next); $(`tab-${next}`).focus();
  });
  $("search-input").addEventListener("input", renderMessages);
  for (const limit of fieldLimits) $(limit[0]).addEventListener("input", () => validateSize(...limit));
  $("composer-form").addEventListener("submit", sendMessage);
  $("reply-to").addEventListener("change", () => selectReply($("reply-to").value));
  $("recipient-list").addEventListener("change", () => { state.replyRecipient = ""; syncComposerAddressing(); });
  $("channel-only").addEventListener("change", updatePermissions);
  $("note-form").addEventListener("submit", publishNote);
  $("new-note-button").addEventListener("click", () => {
    if (!canNote()) return;
    setText($("note-publish-target"), () => (tr("Publish to the whole project “{0}” ({1}), as {2} ({3}).", () => (state.project.name), () => (state.project.id), () => (state.me.name), () => (state.me.id))));
    $("note-dialog").showModal(); $("note-title").focus();
  });
  $("note-cancel").addEventListener("click", () => { if (!state.publishing) $("note-dialog").close(); });
  $("note-dialog").addEventListener("cancel", (event) => { if (state.publishing) event.preventDefault(); });
  window.addEventListener("pagehide", () => lock());
  window.addEventListener("offline", deliveryConnectivityChanged);
  window.addEventListener("online", deliveryConnectivityChanged);
  document.addEventListener("visibilitychange", () => {
    clearTimeout(state.deliveryTimer); state.deliveryTimer = null;
    state.deliverySeq += 1; state.deliveryLoading = false;
    if (state.deliveryAlerts) state.deliveryAlerts.status = "stale";
    renderDeliveryAlerts();
    if (!document.hidden && state.key) { scheduleRefresh(); scheduleChannelRead(); scheduleDeliveryPoll(0); }
  });

  captureStaticTranslations();
  $("language-select")?.addEventListener("change", () => applyLanguage($("language-select").value, true));
  applyLanguage(language);

  $("transport-note").dataset.secure = String(safeTransport);
  setText($("transport-note"), () => (safeTransport
    ? tr("Service: {0}. Your key is sent only to this server in the Authorization header.{1}", () => (location.origin), () => (location.protocol === "http:" ? tr(" HTTP is allowed only for a local loopback test.") : tr(" HTTPS connection.")))
    : tr("Sign-in blocked: network connections require HTTPS. Do not enter your key on an HTTP page. Only localhost / 127.0.0.1 / ::1 are allowed for local testing.")));
  $("key-reveal").disabled = !safeTransport;
  lock();
})();
