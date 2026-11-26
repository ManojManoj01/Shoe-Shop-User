import { Injectable, signal, computed, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { tap, catchError, map, switchMap } from 'rxjs/operators';
import { User, LoginCredentials, SignupData, AuthResponse, UserProfileUpdateDto } from '../models/user.model';
import { environment } from '../../../environments/environment';

const STORAGE_KEY = 'stepstyle_auth_user';
const TOKEN_KEY = 'stepstyle_auth_token';
const DEFAULT_AVATAR = 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=200&q=80';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private platformId = inject(PLATFORM_ID);
  private isBrowser = isPlatformBrowser(this.platformId);
  private http = inject(HttpClient);

  // Angular Signal state
  private currentUserSignal = signal<User | null>(this.getInitialUser());
  private tokenSignal = signal<string | null>(this.getInitialToken());
  public isLoading = signal<boolean>(false);

  // Readonly computed states
  public currentUser = this.currentUserSignal.asReadonly();
  public token = this.tokenSignal.asReadonly();
  public isLoggedIn = computed(() => !!this.currentUserSignal() && !!this.tokenSignal());
  public isAdmin = computed(() => this.currentUserSignal()?.role === 'admin');

  // Profile completion status (0 - 100%)
  public profileCompletion = computed(() => {
    const user = this.currentUserSignal();
    if (!user) return 0;
    return this.calculateProfileScore(user);
  });

  public isProfileComplete = computed(() => {
    return this.profileCompletion() >= 80;
  });

  private authApiUrl = `${(environment.apiUrl || 'https://shoe-shop-backend-1-fpu4.onrender.com').replace(/\/api\/?$/, '')}/api/auth`;

  constructor() {
    if (this.isBrowser) {
      // Purge any legacy un-scoped shared cart keys from older builds
      try {
        localStorage.removeItem('stepstyle_cart_items');
        localStorage.removeItem('stepstyle_cart_coupon');
      } catch {}

      // If a JWT token is already stored, refresh the user profile from Spring Boot / Supabase
      if (this.tokenSignal()) {
        this.refreshCurrentUserProfile().subscribe();
      }
    }
  }

  private calculateProfileScore(user: User): number {
    const checks = [
      !!user.firstName?.trim(),
      !!user.lastName?.trim(),
      !!user.email?.trim(),
      !!user.phone?.trim(),
      !!user.avatar?.trim(),
      !!user.address?.trim(),
      !!user.city?.trim(),
      !!user.postalCode?.trim(),
      !!user.shoeSize,
      !!user.preferredCategory
    ];
    const filled = checks.filter(Boolean).length;
    return Math.round((filled / checks.length) * 100);
  }

  private mapBackendUser(backendUser: any, fallbackIdentifier = ''): User {
    const rawRole = String(backendUser?.role || 'ROLE_USER');
    const user: User = {
      id: String(backendUser?.id || ''),
      username: backendUser?.username || fallbackIdentifier,
      firstName: backendUser?.firstName || backendUser?.username || 'Shopper',
      lastName: backendUser?.lastName || '',
      email: backendUser?.email || '',
      phone: backendUser?.phone || '',
      role: (rawRole === 'ROLE_ADMIN' || rawRole === 'admin') ? 'admin' : 'customer',
      avatar: backendUser?.avatar || DEFAULT_AVATAR,
      address: backendUser?.address || '',
      city: backendUser?.city || '',
      state: backendUser?.state || 'Tamil Nadu',
      postalCode: backendUser?.postalCode || '',
      shoeSize: backendUser?.shoeSize || '',
      preferredCategory: backendUser?.preferredCategory || 'chappals',
      gender: backendUser?.gender || 'unspecified',
      bio: backendUser?.bio || '',
      notifyPromotions: backendUser?.notifyPromotions ?? true,
      notifyOrderUpdates: backendUser?.notifyOrderUpdates ?? true
    };
    user.isProfileComplete = this.calculateProfileScore(user) >= 80;
    return user;
  }

  private getInitialUser(): User | null {
    if (!this.isBrowser) return null;
    try {
      const stored = localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY);
      if (!stored) return null;
      const user: User = JSON.parse(stored);
      if (user.role === 'admin') {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem(TOKEN_KEY);
        return null;
      }
      user.isProfileComplete = this.calculateProfileScore(user) >= 80;
      return user;
    } catch {
      return null;
    }
  }

  private getInitialToken(): string | null {
    if (!this.isBrowser) return null;
    try {
      const token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
      // Reject legacy fake client-generated tokens
      if (!token || token.startsWith('mock_') || token.startsWith('offline_') || token.startsWith('jwt_')) {
        localStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(TOKEN_KEY);
        return null;
      }
      return token;
    } catch {
      return null;
    }
  }

  /**
   * Log in customer account via Spring Boot + Supabase.
   * Rejects administrator accounts (admins must sign in via the dedicated Admin Portal).
   */
  public login(credentials: LoginCredentials): Observable<AuthResponse> {
    this.isLoading.set(true);

    const userIdentifier = credentials.emailOrUsername.trim();
    const payload = {
      usernameOrEmail: userIdentifier,
      password: credentials.password
    };

    return this.http.post<any>(`${this.authApiUrl}/login`, payload).pipe(
      map(res => {
        const backendUser = res?.user || res?.data || {};
        const user = this.mapBackendUser(backendUser, userIdentifier);

        if (user.role === 'admin') {
          throw new Error('Administrator accounts cannot sign in here. Please use the dedicated Admin Portal.');
        }

        const token = res?.accessToken || res?.token;
        if (!token) {
          throw new Error('Authentication token not received from server.');
        }

        return {
          user,
          token,
          message: res?.message || 'Logged in successfully'
        };
      }),
      tap(authRes => {
        this.isLoading.set(false);
        this.saveSession(authRes.user, authRes.token, credentials.rememberMe ?? true);
      }),
      catchError((err: HttpErrorResponse | Error) => {
        this.isLoading.set(false);
        let errorMsg = 'Invalid email/username or password.';
        if (err instanceof HttpErrorResponse) {
          if (err.error?.message) {
            errorMsg = err.error.message;
          } else if (err.status === 0) {
            errorMsg = 'Cannot connect to Spring Boot backend server (https://shoe-shop-backend-1-fpu4.onrender.com).';
          }
        } else if (err.message) {
          errorMsg = err.message;
        }
        return throwError(() => new Error(errorMsg));
      })
    );
  }

  /**
   * Create a new customer account in Supabase via Spring Boot, then sign in to get a real JWT.
   */
  public signup(data: SignupData): Observable<AuthResponse> {
    this.isLoading.set(true);

    const payload = {
      username: data.username.trim(),
      email: data.email.trim().toLowerCase(),
      password: data.password,
      firstName: data.firstName.trim(),
      lastName: data.lastName.trim(),
      confirmPassword: data.confirmPassword || data.password
    };

    return this.http.post<any>(`${this.authApiUrl}/signup`, payload).pipe(
      switchMap(() =>
        this.login({
          emailOrUsername: payload.username,
          password: payload.password,
          rememberMe: true
        })
      ),
      catchError((err: HttpErrorResponse | Error) => {
        this.isLoading.set(false);
        let errorMsg = 'Registration failed. Please try again.';

        if (err instanceof HttpErrorResponse) {
          if (err.error?.message) {
            errorMsg = err.error.message;
          } else if (err.error?.fieldErrors) {
            errorMsg = Object.values(err.error.fieldErrors).join(', ');
          } else if (err.error?.validationErrors) {
            errorMsg = Object.values(err.error.validationErrors).join(', ');
          } else if (err.status === 0) {
            errorMsg = 'Cannot connect to Spring Boot backend server (https://shoe-shop-backend-1-fpu4.onrender.com).';
          }
        } else if (err.message) {
          errorMsg = err.message;
        }

        return throwError(() => new Error(errorMsg));
      })
    );
  }

  /**
   * Refresh current user's profile directly from Spring Boot / Supabase.
   */
  public refreshCurrentUserProfile(): Observable<User | null> {
    if (!this.tokenSignal()) {
      return of(null);
    }
    return this.http.get<any>(`${this.authApiUrl}/me`).pipe(
      map(backendUser => this.mapBackendUser(backendUser)),
      tap(user => {
        if (user.role === 'admin') {
          this.clearLocalSession();
          return;
        }
        this.persistUser(user);
      }),
      catchError(() => of(null))
    );
  }

  /**
   * Update Profile Details for the currently authenticated user only.
   */
  public updateProfile(updatedData: UserProfileUpdateDto): Observable<User> {
    this.isLoading.set(true);

    const currentUser = this.currentUserSignal();
    if (!currentUser || !this.tokenSignal()) {
      this.isLoading.set(false);
      return throwError(() => new Error('You must be logged in to update your profile.'));
    }

    const backendPayload = {
      firstName: updatedData.firstName,
      lastName: updatedData.lastName,
      phone: updatedData.phone,
      address: updatedData.address,
      city: updatedData.city,
      state: updatedData.state,
      postalCode: updatedData.postalCode,
      shoeSize: updatedData.shoeSize ? String(updatedData.shoeSize) : undefined,
      preferredCategory: updatedData.preferredCategory,
      gender: updatedData.gender,
      bio: updatedData.bio,
      avatar: updatedData.avatar,
      notifyPromotions: updatedData.notifyPromotions,
      notifyOrderUpdates: updatedData.notifyOrderUpdates,
      ...(updatedData.newPassword ? { newPassword: updatedData.newPassword } : {})
    };

    return this.http.put<any>(`${this.authApiUrl}/profile`, backendPayload).pipe(
      map(res => {
        const backendUser = res?.data || res?.user || res;
        return this.mapBackendUser(backendUser, currentUser.username);
      }),
      tap(finalUser => {
        this.isLoading.set(false);
        this.persistUser(finalUser);
      }),
      catchError((err: HttpErrorResponse) => {
        this.isLoading.set(false);
        const msg = err.error?.message || 'Could not save profile changes to server.';
        return throwError(() => new Error(msg));
      })
    );
  }

  /**
   * Request password reset link
   */
  public forgotPassword(email: string): Observable<{ success: boolean; message: string }> {
    this.isLoading.set(true);
    return this.http.post<any>(`${this.authApiUrl}/forgot-password`, { email: email.trim().toLowerCase() }).pipe(
      map(res => ({
        success: true,
        message: res?.message || `A secure password reset link has been dispatched to ${email}.`
      })),
      tap(() => this.isLoading.set(false)),
      catchError((err: HttpErrorResponse) => {
        this.isLoading.set(false);
        const msg = err.error?.message || 'Could not send reset password request.';
        return throwError(() => new Error(msg));
      })
    );
  }

  /**
   * Log out and completely clear local & backend session state.
   */
  public logout(): void {
    const hadToken = !!this.tokenSignal();
    this.clearLocalSession();

    if (hadToken) {
      this.http.post(`${this.authApiUrl}/logout`, {}).pipe(
        catchError(() => of(null))
      ).subscribe();
    }
  }

  private clearLocalSession(): void {
    this.currentUserSignal.set(null);
    this.tokenSignal.set(null);

    if (this.isBrowser) {
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem(TOKEN_KEY);
        document.cookie = 'stepstyle_admin_user=; path=/; max-age=0; SameSite=Lax';
        document.cookie = 'stepstyle_admin_token=; path=/; max-age=0; SameSite=Lax';
      } catch (err) {
        console.error('Error clearing session:', err);
      }
    }
  }

  private persistUser(user: User): void {
    user.isProfileComplete = this.calculateProfileScore(user) >= 80;
    this.currentUserSignal.set(user);
    if (!this.isBrowser) return;

    try {
      if (localStorage.getItem(TOKEN_KEY)) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
      } else {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(user));
      }
    } catch (err) {
      console.error('Error persisting profile update:', err);
    }
  }

  private saveSession(user: User, token: string, remember: boolean): void {
    user.isProfileComplete = this.calculateProfileScore(user) >= 80;
    this.currentUserSignal.set(user);
    this.tokenSignal.set(token);

    if (!this.isBrowser) return;

    try {
      const storage = remember ? localStorage : sessionStorage;
      const otherStorage = remember ? sessionStorage : localStorage;

      storage.setItem(STORAGE_KEY, JSON.stringify(user));
      storage.setItem(TOKEN_KEY, token);

      otherStorage.removeItem(STORAGE_KEY);
      otherStorage.removeItem(TOKEN_KEY);
    } catch (err) {
      console.error('Error storing session:', err);
    }
  }
}
