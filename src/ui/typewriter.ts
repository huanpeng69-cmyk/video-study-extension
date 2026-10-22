/** 一步只前进一个 Unicode 码点；换节点或重试时不拼接旧正文。 */
export function advanceTypewriter(current: string, target: string): string {
  if (!target.startsWith(current)) return '';
  const point = Array.from(target.slice(current.length))[0];
  return point === undefined ? current : current + point;
}
