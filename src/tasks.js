export const STORAGE_KEY = 'todo-list.tasks'

export function normalizeTaskText(text) {
  return String(text ?? '').trim()
}

function generateTaskId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function createTask(text, idFactory = generateTaskId) {
  const normalizedText = normalizeTaskText(text)
  if (!normalizedText) {
    throw new Error('Task cannot be blank.')
  }

  return {
    id: idFactory(),
    text: normalizedText,
    completed: false,
  }
}

export function addTask(tasks, text, idFactory) {
  return [...tasks, createTask(text, idFactory)]
}

export function toggleTask(tasks, id) {
  return tasks.map((task) =>
    task.id === id ? { ...task, completed: !task.completed } : task,
  )
}

export function editTask(tasks, id, text) {
  const normalizedText = normalizeTaskText(text)
  if (!normalizedText) {
    throw new Error('Task cannot be blank.')
  }

  return tasks.map((task) => (task.id === id ? { ...task, text: normalizedText } : task))
}

export function deleteTask(tasks, id) {
  return tasks.filter((task) => task.id !== id)
}

export function clearCompleted(tasks) {
  return tasks.filter((task) => !task.completed)
}

export function getFilteredTasks(tasks, filter) {
  if (filter === 'active') {
    return tasks.filter((task) => !task.completed)
  }

  if (filter === 'completed') {
    return tasks.filter((task) => task.completed)
  }

  return tasks
}

export function getActiveCount(tasks) {
  return tasks.filter((task) => !task.completed).length
}

export function saveTasks(tasks, storage = globalThis.localStorage, key = STORAGE_KEY) {
  storage.setItem(key, JSON.stringify(tasks))
}

export function loadTasks(storage = globalThis.localStorage, key = STORAGE_KEY) {
  const value = storage.getItem(key)
  if (!value) {
    return []
  }

  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed
      .filter((task) => task && typeof task.id === 'string' && typeof task.text === 'string')
      .map((task) => ({
        id: task.id,
        text: task.text,
        completed: Boolean(task.completed),
      }))
  } catch {
    return []
  }
}
