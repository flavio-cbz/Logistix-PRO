"use server"

import { revalidatePath } from "next/cache"
import { db, generateId, getCurrentTimestamp } from "./db"
import { requireAuth, createUser, verifyCredentials, createSession, signOut as authSignOut, hashPassword } from "./auth"
import { z } from "zod"
import { v4 as uuidv4 } from "uuid"

// Schémas de validation
const userSchema = z.object({
  username: z.string().min(2, "Le nom d'utilisateur doit faire au moins 2 caractères"),
  email: z.string().email("Email invalide"),
  password: z.string().min(6, "Le mot de passe doit faire au moins 6 caractères"),
})

const loginSchema = z.object({
  email: z.string().email("Email invalide"),
  password: z.string().min(1, "Le mot de passe est requis"),
})

const parcelleSchema = z.object({
  numero: z.string().min(1, "Le numéro est requis"),
  transporteur: z.string().min(1, "Le transporteur est requis"),
  poids: z.number().min(1, "Le poids doit être supérieur à 0"),
  prixTotal: z.number().min(0, "Le prix doit être positif"),
})

const produitSchema = z.object({
  commandeId: z.string().min(1, "L'ID de commande est requis"),
  nom: z.string().min(1, "Le nom est requis"),
  details: z.string().optional(),
  prixArticle: z.number().min(0, "Le prix doit être positif"),
  poids: z.number().min(1, "Le poids doit être positif"),
  parcelleId: z.string().min(1, "La parcelle est requise"),
  vendu: z.boolean().optional(),
  dateVente: z.string().optional(),
  tempsEnLigne: z.string().optional(),
  prixVente: z.number().optional(),
  plateforme: z.string().optional(),
})

// Actions d'authentification
export async function signUp(formData: FormData) {
  const username = formData.get("username") as string
  const email = formData.get("email") as string
  const password = formData.get("password") as string

  console.log("Données reçues pour l'inscription:", { username, email, password: "***" })

  if (!username || !email || !password) {
    console.error("Données d'inscription incomplètes")
    return { success: false, message: "Tous les champs sont requis" }
  }

  try {
    const validatedData = userSchema.parse({ username, email, password })
    console.log("Données validées avec succès")

    const user = createUser(validatedData.username, validatedData.email, validatedData.password)
    console.log("Utilisateur créé avec succès:", user.id)

    const sessionId = createSession(user.id)
    console.log("Session créée avec succès")

    return { success: true, message: "Inscription réussie" }
  } catch (error: any) {
    console.error("Erreur lors de l'inscription:", error)

    // Gestion spécifique des erreurs de validation Zod
    if (error.errors) {
      const errorMessages = error.errors.map((err: any) => err.message).join(", ")
      return { success: false, message: errorMessages }
    }

    return { success: false, message: error.message || "Une erreur s'est produite lors de l'inscription" }
  }
}

// Dans la fonction signIn, utilisons une approche différente pour définir le cookie
export async function signIn(formData: FormData) {
  const email = formData.get("email") as string
  const password = formData.get("password") as string

  console.log("Action signIn appelée avec email:", email)

  try {
    const validatedData = loginSchema.parse({ email, password })

    // Vérifier si la table users existe
    try {
      db.prepare("SELECT 1 FROM users LIMIT 1").get()
    } catch (error: any) {
      console.error("Erreur lors de l'accès à la table users:", error)
      if (error.message.includes("no such table")) {
        return {
          success: false,
          message: "Erreur de base de données: la table users n'existe pas. Veuillez contacter l'administrateur.",
        }
      }
    }

    const user = verifyCredentials(validatedData.email, validatedData.password)

    if (!user) {
      console.log("Identifiants invalides")
      return { success: false, message: "Email ou mot de passe incorrect" }
    }

    console.log("Utilisateur authentifié, création de session pour:", user.id)

    // Supprimer toute session existante pour cet utilisateur
    try {
      const result = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id)
      console.log(
        "Sessions existantes supprimées pour l'utilisateur:",
        user.id,
        "Nombre de sessions supprimées:",
        result.changes,
      )
    } catch (error) {
      console.error("Erreur lors de la suppression des sessions existantes:", error)
    }

    // Créer une nouvelle session
    const sessionId = uuidv4()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 jours

    try {
      db.prepare(`
        INSERT INTO sessions (id, user_id, expires_at)
        VALUES (?, ?, ?)
      `).run(sessionId, user.id, expiresAt)

      console.log("Session créée dans la base de données:", sessionId)

      // Retourner le sessionId pour que le client puisse le définir
      return {
        success: true,
        message: "Connexion réussie",
        sessionId: sessionId,
      }
    } catch (error) {
      console.error("Erreur lors de la création de la session:", error)
      return { success: false, message: "Erreur lors de la création de la session" }
    }
  } catch (error: any) {
    console.error("Erreur dans l'action signIn:", error)
    return { success: false, message: error.message }
  }
}

export async function signOut() {
  authSignOut()
  return { success: true }
}

// Actions pour les parcelles
export async function getParcelles() {
  const user = requireAuth()

  try {
    const parcelles = db
      .prepare(`
      SELECT * FROM parcelles
      WHERE user_id = ?
      ORDER BY created_at DESC
    `)
      .all(user.id)

    return parcelles
  } catch (error: any) {
    console.error("Erreur lors de la récupération des parcelles:", error)
    return []
  }
}

export async function addParcelle(formData: FormData) {
  const user = requireAuth()

  try {
    const numero = formData.get("numero") as string
    const transporteur = formData.get("transporteur") as string
    const poids = Number(formData.get("poids"))
    const prixTotal = Number(formData.get("prixTotal"))

    const validatedData = parcelleSchema.parse({
      numero,
      transporteur,
      poids,
      prixTotal,
    })

    const prixParGramme = validatedData.poids > 0 ? validatedData.prixTotal / validatedData.poids : 0
    const id = generateId()
    const timestamp = getCurrentTimestamp()

    db.prepare(`
      INSERT INTO parcelles (id, numero, transporteur, poids, prixTotal, prixParGramme, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      validatedData.numero,
      validatedData.transporteur,
      validatedData.poids,
      validatedData.prixTotal,
      prixParGramme,
      user.id,
      timestamp,
      timestamp,
    )

    revalidatePath("/parcelles")
    revalidatePath("/dashboard")
    revalidatePath("/statistiques")

    return { success: true, message: "Parcelle ajoutée avec succès" }
  } catch (error: any) {
    return { success: false, message: error.message }
  }
}

export async function updateParcelle(id: string, formData: FormData) {
  const user = requireAuth()

  try {
    const numero = formData.get("numero") as string
    const transporteur = formData.get("transporteur") as string
    const poids = Number(formData.get("poids"))
    const prixTotal = Number(formData.get("prixTotal"))

    const validatedData = parcelleSchema.parse({
      numero,
      transporteur,
      poids,
      prixTotal,
    })

    const prixParGramme = validatedData.poids > 0 ? validatedData.prixTotal / validatedData.poids : 0
    const timestamp = getCurrentTimestamp()

    db.prepare(`
      UPDATE parcelles
      SET numero = ?, transporteur = ?, poids = ?, prixTotal = ?, prixParGramme = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      validatedData.numero,
      validatedData.transporteur,
      validatedData.poids,
      validatedData.prixTotal,
      prixParGramme,
      timestamp,
      id,
      user.id,
    )

    // Mettre à jour les prix de livraison des produits associés
    const produits = db
      .prepare(`
      SELECT id, poids FROM produits
      WHERE parcelleId = ? AND user_id = ?
    `)
      .all(id, user.id)

    const updateProduitStmt = db.prepare(`
      UPDATE produits
      SET prixLivraison = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `)

    for (const produit of produits) {
      const prixLivraison = produit.poids * prixParGramme
      updateProduitStmt.run(prixLivraison, timestamp, produit.id, user.id)
    }

    revalidatePath("/parcelles")
    revalidatePath("/dashboard")
    revalidatePath("/statistiques")

    return { success: true, message: "Parcelle mise à jour avec succès" }
  } catch (error: any) {
    return { success: false, message: error.message }
  }
}

export async function deleteParcelle(id: string) {
  const user = requireAuth()

  try {
    // Vérifier si des produits sont associés à cette parcelle
    const produits = db
      .prepare(`
      SELECT COUNT(*) as count FROM produits
      WHERE parcelleId = ? AND user_id = ?
    `)
      .get(id, user.id)

    if (produits.count > 0) {
      return {
        success: false,
        message: "Impossible de supprimer cette parcelle car des produits y sont associés",
      }
    }

    db.prepare(`
      DELETE FROM parcelles
      WHERE id = ? AND user_id = ?
    `).run(id, user.id)

    revalidatePath("/parcelles")
    revalidatePath("/dashboard")
    revalidatePath("/statistiques")

    return { success: true, message: "Parcelle supprimée avec succès" }
  } catch (error: any) {
    return { success: false, message: error.message }
  }
}

// Actions pour les produits
export async function getProduits() {
  const user = requireAuth()

  try {
    const produits = db
      .prepare(`
      SELECT * FROM produits
      WHERE user_id = ?
      ORDER BY created_at DESC
    `)
      .all(user.id)

    return produits
  } catch (error: any) {
    console.error("Erreur lors de la récupération des produits:", error)
    return []
  }
}

export async function addProduit(formData: FormData) {
  const user = requireAuth()

  try {
    const commandeId = formData.get("commandeId") as string
    const nom = formData.get("nom") as string
    const details = (formData.get("details") as string) || ""
    const prixArticle = Number(formData.get("prixArticle"))
    const poids = Number(formData.get("poids"))
    const parcelleId = formData.get("parcelleId") as string
    const vendu = formData.get("vendu") === "true"

    // Valider les données de base
    const validatedData = produitSchema.parse({
      commandeId,
      nom,
      details,
      prixArticle,
      poids,
      parcelleId,
      vendu,
    })

    // Récupérer le prix par gramme de la parcelle
    const parcelle = db
      .prepare(`
      SELECT prixParGramme FROM parcelles
      WHERE id = ? AND user_id = ?
    `)
      .get(validatedData.parcelleId, user.id)

    if (!parcelle) {
      return { success: false, message: "Parcelle introuvable" }
    }

    const prixLivraison = validatedData.poids * parcelle.prixParGramme
    const id = generateId()
    const timestamp = getCurrentTimestamp()

    // Préparer les données pour l'insertion
    const insertData: any = {
      id,
      commandeId: validatedData.commandeId,
      nom: validatedData.nom,
      details: validatedData.details,
      prixArticle: validatedData.prixArticle,
      poids: validatedData.poids,
      prixLivraison,
      vendu: validatedData.vendu ? 1 : 0,
      parcelleId: validatedData.parcelleId,
      user_id: user.id,
      created_at: timestamp,
      updated_at: timestamp,
    }

    // Si le produit est vendu, ajouter les informations de vente
    if (validatedData.vendu) {
      const dateVente = formData.get("dateVente") as string
      const tempsEnLigne = formData.get("tempsEnLigne") as string
      const prixVente = Number(formData.get("prixVente"))
      const plateforme = formData.get("plateforme") as string

      // Calculer les bénéfices
      const benefices = prixVente - (validatedData.prixArticle + prixLivraison)
      const pourcentageBenefice = (benefices / (validatedData.prixArticle + prixLivraison)) * 100

      Object.assign(insertData, {
        dateVente,
        tempsEnLigne,
        prixVente,
        plateforme,
        benefices,
        pourcentageBenefice,
      })
    }

    // Construire la requête SQL dynamiquement
    const columns = Object.keys(insertData).join(", ")
    const placeholders = Object.keys(insertData)
      .map(() => "?")
      .join(", ")
    const values = Object.values(insertData)

    db.prepare(`
      INSERT INTO produits (${columns})
      VALUES (${placeholders})
    `).run(...values)

    revalidatePath("/produits")
    revalidatePath("/dashboard")
    revalidatePath("/statistiques")

    return { success: true, message: "Produit ajouté avec succès" }
  } catch (error: any) {
    return { success: false, message: error.message }
  }
}

export async function updateProduit(id: string, formData: FormData) {
  const user = requireAuth()

  try {
    const commandeId = formData.get("commandeId") as string
    const nom = formData.get("nom") as string
    const details = (formData.get("details") as string) || ""
    const prixArticle = Number(formData.get("prixArticle"))
    const poids = Number(formData.get("poids"))
    const parcelleId = formData.get("parcelleId") as string
    const vendu = formData.get("vendu") === "true"

    // Valider les données de base
    const validatedData = produitSchema.parse({
      commandeId,
      nom,
      details,
      prixArticle,
      poids,
      parcelleId,
      vendu,
    })

    // Récupérer le prix par gramme de la parcelle
    const parcelle = db
      .prepare(`
      SELECT prixParGramme FROM parcelles
      WHERE id = ? AND user_id = ?
    `)
      .get(validatedData.parcelleId, user.id)

    if (!parcelle) {
      return { success: false, message: "Parcelle introuvable" }
    }

    const prixLivraison = validatedData.poids * parcelle.prixParGramme
    const timestamp = getCurrentTimestamp()

    // Préparer les données pour la mise à jour
    const updateData: any = {
      commandeId: validatedData.commandeId,
      nom: validatedData.nom,
      details: validatedData.details,
      prixArticle: validatedData.prixArticle,
      poids: validatedData.poids,
      prixLivraison,
      vendu: validatedData.vendu ? 1 : 0,
      parcelleId: validatedData.parcelleId,
      updated_at: timestamp,
    }

    // Si le produit est vendu, ajouter les informations de vente
    if (validatedData.vendu) {
      const dateVente = formData.get("dateVente") as string
      const tempsEnLigne = formData.get("tempsEnLigne") as string
      const prixVente = Number(formData.get("prixVente"))
      const plateforme = formData.get("plateforme") as string

      // Calculer les bénéfices
      const benefices = prixVente - (validatedData.prixArticle + prixLivraison)
      const pourcentageBenefice = (benefices / (validatedData.prixArticle + prixLivraison)) * 100

      Object.assign(updateData, {
        dateVente,
        tempsEnLigne,
        prixVente,
        plateforme,
        benefices,
        pourcentageBenefice,
      })
    } else {
      // Si le produit n'est pas vendu, effacer les informations de vente
      Object.assign(updateData, {
        dateVente: null,
        tempsEnLigne: null,
        prixVente: null,
        plateforme: null,
        benefices: null,
        pourcentageBenefice: null,
      })
    }

    // Construire la requête SQL dynamiquement
    const setClause = Object.keys(updateData)
      .map((key) => `${key} = ?`)
      .join(", ")
    const values = [...Object.values(updateData), id, user.id]

    db.prepare(`
      UPDATE produits
      SET ${setClause}
      WHERE id = ? AND user_id = ?
    `).run(...values)

    revalidatePath("/produits")
    revalidatePath("/dashboard")
    revalidatePath("/statistiques")

    return { success: true, message: "Produit mis à jour avec succès" }
  } catch (error: any) {
    return { success: false, message: error.message }
  }
}

export async function deleteProduit(id: string) {
  const user = requireAuth()

  try {
    db.prepare(`
      DELETE FROM produits
      WHERE id = ? AND user_id = ?
    `).run(id, user.id)

    revalidatePath("/produits")
    revalidatePath("/dashboard")
    revalidatePath("/statistiques")

    return { success: true, message: "Produit supprimé avec succès" }
  } catch (error: any) {
    return { success: false, message: error.message }
  }
}

// Actions pour le profil utilisateur
export async function getAppProfile() {
  const user = requireAuth()

  try {
    const profile = db
      .prepare(`
      SELECT username, email, bio, avatar, language, theme
      FROM users
      WHERE id = ?
    `)
      .get(user.id)

    return (
      profile || {
        username: user.username,
        email: user.email,
        bio: "",
        avatar: "",
        language: "fr",
        theme: "system",
      }
    )
  } catch (error: any) {
    console.error("Erreur lors de la récupération du profil:", error)
    return {
      username: user.username,
      email: user.email,
      bio: "",
      avatar: "",
      language: "fr",
      theme: "system",
    }
  }
}

export async function updateAppProfile(formData: FormData) {
  const user = requireAuth()

  try {
    if (!user || !user.id) {
      console.error("Utilisateur non authentifié ou ID manquant")
      return { success: false, message: "Utilisateur non authentifié" }
    }

    const username = formData.get("username") as string
    const email = formData.get("email") as string
    const bio = (formData.get("bio") as string) || ""
    const avatar = (formData.get("avatar") as string) || ""
    const language = (formData.get("language") as string) || "fr"
    const theme = (formData.get("theme") as string) || "system"
    const password = formData.get("password") as string

    console.log("Mise à jour du profil pour l'utilisateur:", user.id)
    console.log("Données reçues:", { username, email, language, theme })

    const timestamp = getCurrentTimestamp()

    try {
      // Mettre à jour le profil dans la base de données SQLite
      if (password && password.length > 0) {
        const passwordHash = hashPassword(password)

        db.prepare(`
          UPDATE users
          SET username = ?, email = ?, bio = ?, avatar = ?, language = ?, theme = ?, password_hash = ?, updated_at = ?
          WHERE id = ?
        `).run(username, email, bio, avatar, language, theme, passwordHash, timestamp, user.id)
      } else {
        db.prepare(`
          UPDATE users
          SET username = ?, email = ?, bio = ?, avatar = ?, language = ?, theme = ?, updated_at = ?
          WHERE id = ?
        `).run(username, email, bio, avatar, language, theme, timestamp, user.id)
      }

      console.log("Profil mis à jour avec succès")
      revalidatePath("/profile")
      return { success: true, message: "Profil mis à jour avec succès" }
    } catch (dbError: any) {
      console.error("Erreur lors de la mise à jour en base de données:", dbError)
      return { success: false, message: `Erreur de base de données: ${dbError.message}` }
    }
  } catch (error: any) {
    console.error("Erreur lors de la mise à jour du profil:", error)
    return { success: false, message: `Une erreur est survenue: ${error.message}` }
  }
}

// Actions pour la configuration du dashboard
export async function getDashboardConfig() {
  const user = requireAuth()

  try {
    const config = db
      .prepare(`
      SELECT config
      FROM dashboard_config
      WHERE user_id = ?
    `)
      .get(user.id)

    if (!config) {
      // Configuration par défaut
      return {
        cards: [
          {
            id: "stats",
            title: "Statistiques principales",
            type: "stats",
            component: "MainStats",
            enabled: true,
            order: 0,
          },
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
          {
            id: "top-produits",
            title: "Top produits",
            type: "table",
            component: "TopProduits",
            enabled: true,
            order: 3,
          },
          {
            id: "temps-vente",
            title: "Temps de vente",
            type: "chart",
            component: "TempsVente",
            enabled: true,
            order: 4,
          },
        ],
        layout: ["stats", "performance", "plateformes", "top-produits", "temps-vente"],
        gridLayout: { lg: 2, md: 1 },
      }
    }

    return JSON.parse(config.config)
  } catch (error: any) {
    console.error("Erreur lors de la récupération de la configuration du dashboard:", error)
    // Configuration par défaut en cas d'erreur
    return {
      cards: [
        {
          id: "stats",
          title: "Statistiques principales",
          type: "stats",
          component: "MainStats",
          enabled: true,
          order: 0,
        },
        {
          id: "performance",
          title: "Performance des ventes",
          type: "chart",
          component: "PerformanceChart",
          enabled: true,
          order: 1,
        },
      ],
      layout: ["stats", "performance"],
      gridLayout: { lg: 2, md: 1 },
    }
  }
}

export async function updateDashboardConfig(config: any) {
  const user = requireAuth()

  try {
    const timestamp = getCurrentTimestamp()
    const configJson = JSON.stringify(config)

    // Vérifier si une configuration existe déjà
    const existingConfig = db
      .prepare(`
      SELECT id FROM dashboard_config
      WHERE user_id = ?
    `)
      .get(user.id)

    if (existingConfig) {
      // Mettre à jour la configuration existante
      db.prepare(`
        UPDATE dashboard_config
        SET config = ?, updated_at = ?
        WHERE user_id = ?
      `).run(configJson, timestamp, user.id)
    } else {
      // Créer une nouvelle configuration
      db.prepare(`
        INSERT INTO dashboard_config (id, user_id, config, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(generateId(), user.id, configJson, timestamp, timestamp)
    }

    revalidatePath("/dashboard")
    return { success: true, message: "Configuration mise à jour avec succès" }
  } catch (error: any) {
    return { success: false, message: error.message }
  }
}

// Actions pour les statistiques
export async function getStatistiques() {
  const user = requireAuth()

  try {
    // Récupérer les produits pour calculer les statistiques
    const produits = db
      .prepare(`
      SELECT * FROM produits
      WHERE user_id = ?
    `)
      .all(user.id)

    // Récupérer les parcelles
    const parcelles = db
      .prepare(`
      SELECT * FROM parcelles
      WHERE user_id = ?
    `)
      .all(user.id)

    // Calculer les statistiques
    const produitsVendus = produits.filter((p) => p.vendu).length
    const ventesTotales = produits.filter((p) => p.vendu && p.prixVente).reduce((sum, p) => sum + p.prixVente, 0)
    const beneficesTotaux = produits.filter((p) => p.benefices).reduce((sum, p) => sum + p.benefices, 0)
    const nombreParcelles = parcelles.length

    return {
      produitsVendus,
      ventesTotales,
      beneficesTotaux,
      nombreParcelles,
    }
  } catch (error: any) {
    console.error("Erreur lors de la récupération des statistiques:", error)
    return {
      produitsVendus: 0,
      ventesTotales: 0,
      beneficesTotaux: 0,
      nombreParcelles: 0,
    }
  }
}

