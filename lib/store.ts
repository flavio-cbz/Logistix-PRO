import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { Parcelle, Produit, DashboardConfig } from "@/types"

// Mettons à jour la configuration par défaut du dashboard avec nos nouveaux composants
const defaultDashboardConfig: DashboardConfig = {
  cards: [
    { id: "stats", title: "Statistiques principales", type: "stats", component: "MainStats", enabled: true, order: 0 },
    {
      id: "performance",
      title: "Performance des ventes",
      type: "chart",
      component: "PerformanceChart",
      enabled: true,
      order: 1,
    },
    {
      id: "plateformes",
      title: "Répartition par plateforme",
      type: "chart",
      component: "VentesPlateformes",
      enabled: true,
      order: 2,
    },
    { id: "top-produits", title: "Top produits", type: "table", component: "TopProduits", enabled: true, order: 3 },
    { id: "temps-vente", title: "Temps de vente", type: "chart", component: "TempsVente", enabled: true, order: 4 },
    {
      id: "marge-mensuelle",
      title: "Marge mensuelle",
      type: "chart",
      component: "MargeMensuelle",
      enabled: false,
      order: 5,
    },
    { id: "top-parcelles", title: "Top parcelles", type: "table", component: "TopParcelles", enabled: false, order: 6 },
    { id: "cout-poids", title: "Coût par poids", type: "chart", component: "CoutPoids", enabled: false, order: 7 },
    {
      id: "tendances",
      title: "Tendances de vente",
      type: "chart",
      component: "TendancesVente",
      enabled: false,
      order: 8,
    },
  ],
  layout: ["stats", "performance", "plateformes", "top-produits", "temps-vente"],
  gridLayout: { lg: 2, md: 1 },
}

// Calcul des bénéfices et du pourcentage
function calculerBenefices(produit: Partial<Produit>) {
  if (!produit.vendu || !produit.prixVente || !produit.prixArticle || !produit.prixLivraison) {
    return { benefices: 0, pourcentageBenefice: 0 }
  }

  const coutTotal = produit.prixArticle + produit.prixLivraison
  const benefices = produit.prixVente - coutTotal
  const pourcentageBenefice = (benefices / coutTotal) * 100

  return { benefices, pourcentageBenefice }
}

// Calcul du prix de livraison basé sur le poids et le prix par gramme de la parcelle
function calculPrixLivraison(poids: number, parcelles: Parcelle[], parcelleId: string): number {
  const parcelle = parcelles.find((p) => p.id === parcelleId)
  if (!parcelle) return 0

  return poids * parcelle.prixParGramme
}

interface StoreState {
  parcelles: Parcelle[]
  produits: Produit[]
  dashboardConfig: DashboardConfig
  notifications: { id: string; type: "success" | "error" | "warning" | "info"; message: string }[]

  // Actions
  initializeStore: () => void

  // Parcelles
  addParcelle: (parcelle: Omit<Parcelle, "id" | "createdAt" | "updatedAt" | "prixParGramme">) => void
  updateParcelle: (id: string, data: Partial<Parcelle>) => void
  deleteParcelle: (id: string) => void

  // Produits
  addProduit: (
    produit: Omit<Produit, "id" | "createdAt" | "updatedAt" | "prixLivraison" | "benefices" | "pourcentageBenefice">,
  ) => void
  updateProduit: (id: string, data: Partial<Produit>) => void
  updateProduitVente: (id: string, data: Partial<Produit>) => void
  deleteProduit: (id: string) => void

  // Dashboard
  updateDashboardConfig: (config: DashboardConfig) => void

  // Notifications
  addNotification: (type: "success" | "error" | "warning" | "info", message: string) => void
  clearNotification: (id: string) => void

  // Import/Export
  importData: (data: any) => void
  exportData: () => { parcelles: Parcelle[]; produits: Produit[]; dashboardConfig: DashboardConfig }

  syncWithDatabase: () => Promise<boolean>
  loadFromDatabase: () => Promise<boolean>
}

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      parcelles: [],
      produits: [],
      dashboardConfig: defaultDashboardConfig,
      notifications: [],

      initializeStore: async () => {
        try {
          // Essayer de charger depuis la base de données d'abord
          const success = await get().loadFromDatabase()

          // Si le chargement a échoué, utiliser les données locales
          if (!success) {
            console.log("Utilisation des données locales")
          }
        } catch (error) {
          console.error("Erreur lors de l'initialisation du store:", error)
        }
      },

      // Parcelles
      addParcelle: (parcelle) => {
        const prixParGramme = parcelle.poids > 0 ? parcelle.prixTotal / parcelle.poids : 0

        const newParcelle: Parcelle = {
          ...parcelle,
          id: crypto.randomUUID(),
          prixParGramme,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }

        set((state) => ({ parcelles: [...state.parcelles, newParcelle] }))
        get().addNotification("success", `La parcelle ${parcelle.numero} a été ajoutée avec succès.`)

        // Synchroniser avec la base de données
        get().syncWithDatabase()
      },

      updateParcelle: (id, data) => {
        const { parcelles } = get()
        const currentParcelle = parcelles.find((p) => p.id === id)

        if (!currentParcelle) return

        let updateData = { ...data }

        // Recalculer le prix par gramme si nécessaire
        if (data.prixTotal !== undefined || data.poids !== undefined) {
          const prixTotal = data.prixTotal ?? currentParcelle.prixTotal
          const poids = data.poids ?? currentParcelle.poids

          const prixParGramme = poids > 0 ? prixTotal / poids : 0

          updateData = {
            ...data,
            prixParGramme,
          }
        }

        set((state) => ({
          parcelles: state.parcelles.map((p) =>
            p.id === id ? { ...p, ...updateData, updatedAt: new Date().toISOString() } : p,
          ),
        }))

        get().addNotification("success", `La parcelle a été mise à jour avec succès.`)

        // Mettre à jour les prix de livraison des produits associés à cette parcelle
        if (updateData.prixParGramme !== undefined) {
          const { produits, parcelles } = get()
          const produitsAMettreAJour = produits.filter((p) => p.parcelleId === id)

          produitsAMettreAJour.forEach((produit) => {
            const prixLivraison = calculPrixLivraison(produit.poids, parcelles, id)

            const { benefices, pourcentageBenefice } = calculerBenefices({
              ...produit,
              prixLivraison,
            })

            get().updateProduit(produit.id, {
              prixLivraison,
              benefices,
              pourcentageBenefice,
            })
          })
        }

        // Synchroniser avec la base de données
        get().syncWithDatabase()
      },

      deleteParcelle: (id) => {
        set((state) => ({
          parcelles: state.parcelles.filter((p) => p.id !== id),
        }))
        get().addNotification("success", `La parcelle a été supprimée avec succès.`)

        // Synchroniser avec la base de données
        get().syncWithDatabase()
      },

      // Produits
      addProduit: (produit) => {
        const { parcelles } = get()
        const prixLivraison = calculPrixLivraison(produit.poids, parcelles, produit.parcelleId)

        const { benefices, pourcentageBenefice } = calculerBenefices({
          ...produit,
          prixLivraison,
        })

        const newProduit: Produit = {
          ...produit,
          id: crypto.randomUUID(),
          prixLivraison,
          benefices,
          pourcentageBenefice,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }

        set((state) => ({ produits: [...state.produits, newProduit] }))
        get().addNotification("success", `Le produit ${produit.nom} a été ajouté avec succès.`)

        // Synchroniser avec la base de données
        get().syncWithDatabase()
      },

      updateProduit: (id, data) => {
        const { produits, parcelles } = get()
        const currentProduit = produits.find((p) => p.id === id)

        if (!currentProduit) return

        let updateData = { ...data }

        if (
          data.poids ||
          data.parcelleId ||
          data.prixArticle ||
          data.prixVente !== undefined ||
          data.vendu !== undefined
        ) {
          const parcelleId = data.parcelleId || currentProduit.parcelleId
          const poids = data.poids || currentProduit.poids

          const prixLivraison = calculPrixLivraison(poids, parcelles, parcelleId)

          const { benefices, pourcentageBenefice } = calculerBenefices({
            ...currentProduit,
            ...data,
            prixLivraison,
          })

          updateData = {
            ...data,
            prixLivraison,
            benefices,
            pourcentageBenefice,
          }
        }

        set((state) => ({
          produits: state.produits.map((p) =>
            p.id === id ? { ...p, ...updateData, updatedAt: new Date().toISOString() } : p,
          ),
        }))

        get().addNotification("success", `Le produit a été mis à jour avec succès.`)

        // Synchroniser avec la base de données
        get().syncWithDatabase()
      },

      updateProduitVente: (id, data) => {
        const { produits } = get()
        const currentProduit = produits.find((p) => p.id === id)

        if (!currentProduit) return

        const updatedProduit = {
          ...currentProduit,
          ...data,
          updatedAt: new Date().toISOString(),
        }

        const { benefices, pourcentageBenefice } = calculerBenefices(updatedProduit)

        updatedProduit.benefices = benefices
        updatedProduit.pourcentageBenefice = pourcentageBenefice

        set((state) => ({
          produits: state.produits.map((p) => (p.id === id ? updatedProduit : p)),
        }))

        get().addNotification("success", `La vente du produit a été enregistrée avec succès.`)

        // Synchroniser avec la base de données
        get().syncWithDatabase()
      },

      deleteProduit: (id) => {
        set((state) => ({
          produits: state.produits.filter((p) => p.id !== id),
        }))
        get().addNotification("success", `Le produit a été supprimé avec succès.`)

        // Synchroniser avec la base de données
        get().syncWithDatabase()
      },

      // Dashboard
      updateDashboardConfig: (config) => {
        set({ dashboardConfig: config })
      },

      // Notifications
      addNotification: (type, message) => {
        const newNotification = {
          id: crypto.randomUUID(),
          type,
          message,
        }
        set((state) => ({
          notifications: [newNotification, ...state.notifications.slice(0, 9)],
        }))

        // Supprimer automatiquement la notification après 5 secondes
        setTimeout(() => {
          get().clearNotification(newNotification.id)
        }, 5000)
      },

      clearNotification: (id) => {
        set((state) => ({
          notifications: state.notifications.filter((n) => n.id !== id),
        }))
      },

      // Import/Export
      importData: (data) => {
        // Fonctionnalité temporairement désactivée
        console.log("Fonctionnalité d'importation temporairement désactivée")
        get().addNotification("warning", "La fonctionnalité d'importation est temporairement désactivée.")
        return false
      },

      exportData: () => {
        // Fonctionnalité temporairement désactivée
        console.log("Fonctionnalité d'exportation temporairement désactivée")
        get().addNotification("warning", "La fonctionnalité d'exportation est temporairement désactivée.")
        return {
          parcelles: [],
          produits: [],
          dashboardConfig: defaultDashboardConfig,
          exportDate: new Date().toISOString(),
        }
      },

      // Améliorer la synchronisation avec la base de données
      syncWithDatabase: async () => {
        try {
          const { parcelles, produits } = get()

          // Envoyer les données au serveur
          const response = await fetch("/api/data/sync", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ parcelles, produits }),
            // Ajouter un timeout pour éviter les blocages
            signal: AbortSignal.timeout(10000),
          })

          if (!response.ok) {
            throw new Error(`Erreur HTTP: ${response.status}`)
          }

          const result = await response.json()

          if (!result.success) {
            throw new Error(result.message)
          }

          // Ajouter une notification de succès
          get().addNotification("success", "Données synchronisées avec le serveur")
          return true
        } catch (error) {
          console.error("Erreur lors de la synchronisation avec la base de données:", error)
          // Ajouter une notification d'erreur
          get().addNotification("error", "Échec de la synchronisation avec le serveur")
          return false
        }
      },

      loadFromDatabase: async () => {
        try {
          // Récupérer les données du serveur
          const response = await fetch("/api/data/sync", {
            // Ajouter un timeout pour éviter les blocages
            signal: AbortSignal.timeout(10000),
          })

          if (!response.ok) {
            throw new Error(`Erreur HTTP: ${response.status}`)
          }

          const result = await response.json()

          if (!result.success) {
            throw new Error(result.message)
          }

          // Mettre à jour le store avec les données récupérées
          set({
            parcelles: result.data.parcelles,
            produits: result.data.produits,
          })

          // Ajouter une notification de succès
          get().addNotification("info", "Données chargées depuis le serveur")
          return true
        } catch (error) {
          console.error("Erreur lors du chargement depuis la base de données:", error)
          // Ajouter une notification d'erreur
          get().addNotification("warning", "Utilisation des données locales")
          return false
        }
      },
    }),
    {
      name: "logistix-storage",
      partialize: (state) => ({
        parcelles: state.parcelles,
        produits: state.produits,
        dashboardConfig: state.dashboardConfig,
      }),
    },
  ),
)

