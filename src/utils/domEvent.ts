/**
 * 表单事件取值助手。
 *
 * 模板里直接写 `$event.target.checked` 在类型检查下会报 TS2339：
 * `Event.target` 的类型是 `EventTarget | null`，不带 `checked` / `value`。
 * 浏览器里这两类 input 事件的目标**确实**是对应元素，所以这里做一次窄化，
 * 把断言集中在一处，模板保持 `@change="fn(checkedOf($event))"` 的可读写法。
 *
 * 为什么不在模板里直接断言：Vue 模板表达式不是完整 TS 上下文。
 */

/** 取 checkbox / radio 的勾选态。 */
export function checkedOf(e: Event): boolean {
  return (e.target as HTMLInputElement).checked
}

/** 取 input / select / textarea 的当前值。 */
export function valueOf(e: Event): string {
  return (e.target as HTMLInputElement).value
}
