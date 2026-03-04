/** Toast notifications for crafting discoveries */
export interface DiscoveryLogAPI {
  addDiscovery(agentName: string, objectName: string, ingredient1: string, ingredient2: string): void;
}

export function setupDiscoveryLog(): DiscoveryLogAPI {
  // Create container
  const container = document.createElement("div");
  container.id = "discovery-log";
  container.style.cssText = `
    position: fixed;
    top: 60px;
    right: 20px;
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  `;
  document.body.appendChild(container);

  // Inject styles
  const style = document.createElement("style");
  style.textContent = `
    .discovery-toast {
      background: rgba(46, 204, 113, 0.92);
      color: white;
      padding: 10px 16px;
      border-radius: 8px;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.3);
      animation: discovery-slide-in 0.3s ease;
      max-width: 280px;
    }
    .discovery-toast .discovery-title {
      font-weight: 600;
      margin-bottom: 2px;
    }
    .discovery-toast .discovery-recipe {
      font-size: 11px;
      opacity: 0.85;
    }
    @keyframes discovery-slide-in {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @keyframes discovery-fade-out {
      from { opacity: 1; }
      to { opacity: 0; transform: translateY(-10px); }
    }
    .item-label {
      font-size: 10px;
      color: #fff;
      background: rgba(0, 0, 0, 0.55);
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.2);
      pointer-events: none;
      white-space: nowrap;
      font-family: system-ui, sans-serif;
    }
  `;
  document.head.appendChild(style);

  return {
    addDiscovery(agentName, objectName, ingredient1, ingredient2) {
      const toast = document.createElement("div");
      toast.className = "discovery-toast";
      toast.innerHTML = `
        <div class="discovery-title">New Discovery: ${objectName}!</div>
        <div class="discovery-recipe">${agentName} combined ${ingredient1} + ${ingredient2}</div>
      `;
      container.appendChild(toast);

      // Auto-remove after 5s
      setTimeout(() => {
        toast.style.animation = "discovery-fade-out 0.4s ease forwards";
        setTimeout(() => toast.remove(), 400);
      }, 5000);
    },
  };
}
