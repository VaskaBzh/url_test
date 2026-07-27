# Architecture: Structured Modules (Technical Layers)

## Обзор
Для этого проекта выбрана архитектура `Structured Modules (Technical Layers)`. Она подходит небольшому full-stack сервису с одной четкой доменной зоной `jobs`, где важно быстро развивать продукт, но уже сейчас удерживать границы между HTTP-слоем, бизнес-логикой, UI-состоянием и инфраструктурными деталями.

На сервере эта архитектура уже естественно проявляется через модуль `server/src/jobs`: контроллер принимает HTTP-запросы, сервис управляет жизненным циклом задач и ограничением параллелизма, DTO и типы вынесены отдельно. На клиенте используется совместимый layered-подход внутри `client/src`: API-адаптер отвечает только за HTTP, Pinia store координирует состояние и polling, а Vue-компоненты остаются тонким представлением и работают через `props`/`emits`.

## Обоснование выбора
- **Тип проекта:** full-stack сервис асинхронной проверки URL с NestJS API, Vue-клиентом и production smoke-проверкой.
- **Стек:** TypeScript, NestJS 11, Vue 3, Pinia, Vite, Jest, Vitest, Docker Compose.
- **Ключевой фактор:** проект пока небольшой, но уже требует воспроизводимой поставки, тестируемых границ и предсказуемого роста без переноса бизнес-логики в контроллеры и компоненты.

## Структура каталогов
```text
repo-root/
|-- client/
|   |-- src/
|   |   |-- api/                       # HTTP adapters for the NestJS API
|   |   |   `-- jobs.api.ts
|   |   |-- components/                # Pure UI blocks and component contracts
|   |   |   |-- JobForm.vue
|   |   |   |-- JobForm.types.ts
|   |   |   |-- JobList.vue
|   |   |   |-- JobList.types.ts
|   |   |   |-- JobDetails.vue
|   |   |   `-- JobDetails.types.ts
|   |   |-- store/                     # UI orchestration, polling, optimistic state
|   |   |   `-- jobs.store.ts
|   |   |-- assets/
|   |   |-- types.ts                   # Shared client-side contracts
|   |   |-- App.vue
|   |   `-- main.ts
|   |-- vite.config.ts
|   `-- vitest.config.ts
|-- server/
|   |-- src/
|   |   |-- jobs/                      # Domain module
|   |   |   |-- dto/
|   |   |   |   `-- create-job.dto.ts
|   |   |   |-- jobs.controller.ts     # HTTP layer
|   |   |   |-- jobs.service.ts        # Application/service layer
|   |   |   `-- jobs.types.ts          # Module contracts and domain state
|   |   |-- app.module.ts
|   |   `-- main.ts
|   `-- test/
|-- scripts/
|   |-- smoke.mjs                      # Production smoke verification
|   `-- smoke.test.mjs
|-- Dockerfile
|-- docker-compose.yml
`-- Makefile
```

## Правила зависимостей
На сервере зависимости направлены строго вниз: `Controller -> Service -> Node HTTP adapters`. В текущей версии инфраструктурные вызовы еще находятся внутри `JobsService`, но они не должны просачиваться обратно в контроллеры или DTO.

На клиенте зависимости направлены так: `Vue components -> Pinia store -> API adapter -> backend`. Компоненты не знают о `fetch`, store не знает о DOM-разметке, а API-слой не хранит UI-состояние.

- ✅ `jobs.controller.ts` может вызывать только `JobsService` и работать с DTO/route parameters.
- ✅ `jobs.store.ts` может вызывать только `client/src/api/jobs.api.ts` и обновлять reactive state.
- ✅ Контракты компонентов нужно держать рядом в `*.types.ts`, а общие клиентские типы централизовать в `client/src/types.ts`.
- ✅ Production-операции доставки (`Dockerfile`, `docker-compose.yml`, `scripts/smoke.mjs`, `Makefile`) остаются вне доменной логики и не импортируются в runtime-код приложения.
- ❌ Vue-компоненты не должны напрямую вызывать `fetch`, `createJob`, `getJob` или управлять polling-таймерами.
- ❌ NestJS контроллеры не должны содержать логику валидации доменных переходов, ограничения параллелизма или прямые вызовы `node:http`.
- ❌ Нельзя дублировать типы `Job`, `JobSummary`, `UrlCheck` в нескольких слоях с разными формами без явного адаптера.

## Коммуникация слоев и модулей
- Клиентский поток: `JobForm.vue` эмитит сырое содержимое textarea, `jobs.store.ts` разбирает ввод, вызывает `jobs.api.ts`, затем управляет списком задач и polling.
- Серверный поток: `JobsController` принимает запрос, `JobsService` создает job, запускает ограниченную по конкурентности обработку и отдает результаты через чтение состояния.
- Контракты между клиентом и сервером должны меняться синхронно: сначала обновляется серверный ответ, затем клиентский adapter/type слой, и только после этого компоненты или store.
- Если на сервере появится персистентность, новый repository-слой добавляется под `server/src/jobs/` или в отдельный infrastructure-подкаталог, а внешний контракт контроллера не меняется.

## Ключевые принципы
1. `JobsService` владеет жизненным циклом job и всей логикой конкурентной обработки URL; контроллеры только доставляют запросы.
2. Vue-компоненты остаются декларативными: состояние, polling и обработка ошибок живут в Pinia store, а не в шаблонах.
3. HTTP-адаптеры и инфраструктурные детали изолированы: `client/src/api/jobs.api.ts` скрывает транспорт от UI, а серверные network-вызовы не должны разрастаться за пределы одной сервисной границы.
4. Контракты централизованы и именованы явно: экспортируемые типы, DTO и `*.types.ts` файлы являются единственной точкой правды для структур данных.
5. Архитектура должна эволюционировать по модулю `jobs`, а не через глобальную папку `shared` без границ. Новые доменные зоны добавляются как отдельные модули, а не расширяют `jobs.service.ts` бесконечно.

## Примеры кода

### Vue-компонент передает событие, а не запускает HTTP сам
```ts
// client/src/components/JobForm.vue
const emit = defineEmits<JobFormEmits>();

function submit(): void {
  emit('submit', urlsText.value);
}
```

```ts
// client/src/store/jobs.store.ts
async function submitJob(textareaValue: string): Promise<boolean> {
  const urls = textareaValue
    .split(/\r?\n/)
    .map((url) => url.trim())
    .filter(Boolean);

  const { jobId } = await createJob(urls);
  await Promise.all([loadJobs(), selectJob(jobId)]);
  return true;
}
```

### NestJS контроллер делегирует бизнес-логику сервису
```ts
// server/src/jobs/jobs.controller.ts
@Post()
create(@Body() createJobDto: CreateJobDto) {
  return this.jobsService.create(createJobDto.urls);
}
```

```ts
// server/src/jobs/jobs.service.ts
create(rawUrls: unknown): { jobId: string } {
  const urls = this.validateUrls(rawUrls);
  const job: Job = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    urlChecks: urls.map((url) => ({ url, status: 'pending' })),
  };

  this.jobs.set(job.id, job);
  void this.processJob(job);
  return { jobId: job.id };
}
```

## Антипаттерны
- ❌ Добавлять новую продуктовую функциональность в `App.vue` вместо выделения компонента, store-функции и API-адаптера.
- ❌ Смешивать HTTP-ошибки, UI-сообщения и бизнес-решения в одном методе компонента.
- ❌ Превращать `JobsService` в god-service для всех будущих доменов вместо создания новых модулей.
- ❌ Прятать реальные контракты внутри компонентов или сервисов, когда им нужно жить в `*.types.ts` или DTO-файлах.
- ❌ Подключать Docker/smoke-скрипты к runtime-коду приложения или делать из delivery-слоя источник бизнес-правил.

## Правила эволюции
- Следующая крупная доменная зона должна появляться как отдельный модуль на сервере и как отдельный feature-flow на клиенте, а не как расширение `jobs` без границ.
- Если появится база данных или очередь, выделяй repository/adapter слой так, чтобы `JobsService` зависел от абстракции, а не от конкретной реализации.
- Если store начнет разрастаться, разделяй его на domain-oriented stores или composables, сохраняя правило: UI не ходит в API напрямую.
- Любое изменение контрактов API сопровождается обновлением unit/e2e/frontend тестов и smoke-сценария поставки.
