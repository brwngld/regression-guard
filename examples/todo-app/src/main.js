import './style.css'
import {
  addTask,
  clearCompleted,
  deleteTask,
  editTask,
  getActiveCount,
  getFilteredTasks,
  loadTasks,
  saveTasks,
  toggleTask,
} from './tasks'

const app = document.querySelector('#app')

const state = {
  tasks: loadTasks(),
  filter: 'all',
  editingId: null,
  editText: '',
  error: '',
}

app.innerHTML = `
  <main class="todo-app" aria-labelledby="todo-title">
    <header class="todo-header">
      <h1 id="todo-title">To-Do List</h1>
      <p>Stay focused with a lightweight task tracker.</p>
    </header>

    <form id="todo-form" class="todo-form" novalidate>
      <label for="new-task" class="sr-only">Add a new task</label>
      <input id="new-task" name="task" type="text" maxlength="200" autocomplete="off" placeholder="Add a task" />
      <button type="submit">Add</button>
    </form>

    <p id="form-error" class="error" role="alert" aria-live="polite"></p>

    <section aria-label="Task filters" class="filters" id="filter-controls">
      <button type="button" data-filter="all">All</button>
      <button type="button" data-filter="active">Active</button>
      <button type="button" data-filter="completed">Completed</button>
    </section>

    <ul id="todo-list" class="todo-list" aria-live="polite"></ul>

    <footer class="todo-footer">
      <p id="task-count"></p>
      <button id="clear-completed" type="button">Clear completed</button>
    </footer>
  </main>
`

const form = document.querySelector('#todo-form')
const taskInput = document.querySelector('#new-task')
const errorMessage = document.querySelector('#form-error')
const list = document.querySelector('#todo-list')
const count = document.querySelector('#task-count')
const filterControls = document.querySelector('#filter-controls')
const clearCompletedButton = document.querySelector('#clear-completed')

function persistTasks() {
  saveTasks(state.tasks)
}

function render() {
  const filteredTasks = getFilteredTasks(state.tasks, state.filter)
  const activeCount = getActiveCount(state.tasks)
  const completedCount = state.tasks.length - activeCount

  errorMessage.textContent = state.error

  count.textContent = `${activeCount} ${activeCount === 1 ? 'task' : 'tasks'} remaining`
  clearCompletedButton.disabled = completedCount === 0

  for (const button of filterControls.querySelectorAll('button')) {
    const isActive = button.dataset.filter === state.filter
    button.classList.toggle('active', isActive)
    button.setAttribute('aria-pressed', String(isActive))
  }

  list.innerHTML = ''

  if (filteredTasks.length === 0) {
    const emptyState = document.createElement('li')
    emptyState.className = 'empty-state'
    emptyState.textContent =
      state.filter === 'all'
        ? 'No tasks yet. Add one above to get started.'
        : state.filter === 'active'
          ? 'No active tasks.'
          : 'No completed tasks.'
    list.append(emptyState)
    return
  }

  for (const task of filteredTasks) {
    const item = document.createElement('li')
    item.className = 'todo-item'

    const left = document.createElement('div')
    left.className = 'task-content'

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = task.completed
    checkbox.setAttribute('aria-label', `Mark ${task.text} as ${task.completed ? 'incomplete' : 'complete'}`)
    checkbox.addEventListener('change', () => {
      state.tasks = toggleTask(state.tasks, task.id)
      persistTasks()
      render()
    })

    left.append(checkbox)

    const isEditing = state.editingId === task.id

    if (isEditing) {
      const editInput = document.createElement('input')
      editInput.type = 'text'
      editInput.value = state.editText
      editInput.maxLength = 200
      editInput.setAttribute('aria-label', `Edit task ${task.text}`)
      editInput.addEventListener('input', (event) => {
        state.editText = event.target.value
      })
      editInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          saveEdit(task.id)
        }

        if (event.key === 'Escape') {
          cancelEdit()
        }
      })

      left.append(editInput)
      item.append(left)

      const actions = document.createElement('div')
      actions.className = 'task-actions'

      const saveButton = document.createElement('button')
      saveButton.type = 'button'
      saveButton.textContent = 'Save'
      saveButton.addEventListener('click', () => saveEdit(task.id))

      const cancelButton = document.createElement('button')
      cancelButton.type = 'button'
      cancelButton.textContent = 'Cancel'
      cancelButton.addEventListener('click', cancelEdit)

      actions.append(saveButton, cancelButton)
      item.append(actions)

      list.append(item)
      queueMicrotask(() => editInput.focus())
      continue
    }

    const taskLabel = document.createElement('span')
    taskLabel.textContent = task.text
    if (task.completed) {
      taskLabel.className = 'completed'
    }

    left.append(taskLabel)
    item.append(left)

    const actions = document.createElement('div')
    actions.className = 'task-actions'

    const editButton = document.createElement('button')
    editButton.type = 'button'
    editButton.textContent = 'Edit'
    editButton.setAttribute('aria-label', `Edit ${task.text}`)
    editButton.addEventListener('click', () => {
      state.editingId = task.id
      state.editText = task.text
      state.error = ''
      render()
    })

    const deleteButton = document.createElement('button')
    deleteButton.type = 'button'
    deleteButton.textContent = 'Delete'
    deleteButton.setAttribute('aria-label', `Delete ${task.text}`)
    deleteButton.addEventListener('click', () => {
      state.tasks = deleteTask(state.tasks, task.id)
      persistTasks()
      if (state.editingId === task.id) {
        state.editingId = null
        state.editText = ''
      }
      render()
    })

    actions.append(editButton, deleteButton)
    item.append(actions)

    list.append(item)
  }
}

function cancelEdit() {
  state.editingId = null
  state.editText = ''
  state.error = ''
  render()
}

function saveEdit(taskId) {
  try {
    state.tasks = editTask(state.tasks, taskId, state.editText)
    state.editingId = null
    state.editText = ''
    state.error = ''
    persistTasks()
  } catch (error) {
    state.error = error.message
  }

  render()
}

form.addEventListener('submit', (event) => {
  event.preventDefault()

  try {
    state.tasks = addTask(state.tasks, taskInput.value)
    taskInput.value = ''
    state.error = ''
    persistTasks()
  } catch (error) {
    state.error = error.message
  }

  render()
  taskInput.focus()
})

filterControls.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]')
  if (!button) {
    return
  }

  state.filter = button.dataset.filter
  render()
})

clearCompletedButton.addEventListener('click', () => {
  state.tasks = clearCompleted(state.tasks)
  persistTasks()
  if (state.filter === 'completed') {
    state.filter = 'all'
  }
  render()
})

render()
