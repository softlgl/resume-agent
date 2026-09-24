// EF Core 映射现有 Prisma 建的表：表名/列名与 schema.prisma 完全对齐（无 @@map → 驼峰原样）。
// EF 为纯消费方：不建迁移、不 EnsureCreated、不 Migrate。

using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using ResumeAgent.Api.Common;
using ResumeAgent.Api.Contracts;

namespace ResumeAgent.Api.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    /// <summary>ResumeContent ↔ JSON 字符串（整块读写，等价 Prisma Json 语义）</summary>
    public class ResumeContentConverter() : ValueConverter<ResumeContent, string>(
        v => ToJson(v),
        v => FromJson(v))
    {
        public static string ToJson(ResumeContent v) => JsonSerializer.Serialize(v, JsonOpts);
        public static ResumeContent FromJson(string v) =>
            JsonSerializer.Deserialize<ResumeContent>(v, JsonOpts)?.Normalize() ?? ResumeContent.Empty();
    }

    public DbSet<User> Users => Set<User>();
    public DbSet<AiModelProfile> AiModelProfiles => Set<AiModelProfile>();
    public DbSet<LlmCallLog> LlmCallLogs => Set<LlmCallLog>();
    public DbSet<Resume> Resumes => Set<Resume>();

    /// <summary>camelCase（与 Prisma 写入的 JSON 键名一致），大小写不敏感、容忍 null</summary>
    public static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
    };

    protected override void OnModelCreating(ModelBuilder mb)
    {
        mb.Entity<User>(e =>
        {
            e.ToTable("User");
            e.Property(x => x.Id).HasColumnName("id").HasMaxLength(32).ValueGeneratedNever();
            e.Property(x => x.Username).HasColumnName("username").HasMaxLength(64);
            e.Property(x => x.Password).HasColumnName("password").HasMaxLength(128);
            e.Property(x => x.CreatedAt).HasColumnName("createdAt").HasColumnType("datetime(3)");
            e.HasIndex(x => x.Username).IsUnique();
        });

        mb.Entity<AiModelProfile>(e =>
        {
            e.ToTable("AiModelProfile");
            e.Property(x => x.Id).HasColumnName("id").HasMaxLength(32).ValueGeneratedNever();
            e.Property(x => x.Name).HasColumnName("name").HasMaxLength(128);
            e.Property(x => x.Provider).HasColumnName("provider").HasMaxLength(32);
            e.Property(x => x.ApiKey).HasColumnName("apiKey").HasMaxLength(512);
            e.Property(x => x.BaseUrl).HasColumnName("baseUrl").HasMaxLength(256);
            e.Property(x => x.Model).HasColumnName("model").HasMaxLength(128);
            e.Property(x => x.MaxContext).HasColumnName("maxContext");
            e.Property(x => x.MaxOutput).HasColumnName("maxOutput");
            e.Property(x => x.Active).HasColumnName("active");
            e.Property(x => x.CreatedAt).HasColumnName("createdAt").HasColumnType("datetime(3)");
        });

        mb.Entity<LlmCallLog>(e =>
        {
            e.ToTable("LlmCallLog");
            e.Property(x => x.Id).HasColumnName("id").HasMaxLength(32).ValueGeneratedNever();
            e.Property(x => x.UserId).HasColumnName("userId").HasMaxLength(32);
            e.Property(x => x.Kind).HasColumnName("kind").HasMaxLength(16);
            e.Property(x => x.ResumeId).HasColumnName("resumeId").HasMaxLength(32);
            e.Property(x => x.Provider).HasColumnName("provider").HasMaxLength(32);
            e.Property(x => x.Model).HasColumnName("model").HasMaxLength(128);
            e.Property(x => x.Ok).HasColumnName("ok");
            e.Property(x => x.Reasoning).HasColumnName("reasoning").HasColumnType("text");
            e.Property(x => x.Output).HasColumnName("output").HasColumnType("text");
            e.Property(x => x.CreatedAt).HasColumnName("createdAt").HasColumnType("datetime(3)");
            e.HasIndex(x => new { x.UserId, x.CreatedAt });
            e.HasIndex(x => new { x.ResumeId, x.CreatedAt });
        });

        mb.Entity<Resume>(e =>
        {
            e.ToTable("Resume");
            e.Property(x => x.Id).HasColumnName("id").HasMaxLength(32).ValueGeneratedNever();
            e.Property(x => x.UserId).HasColumnName("userId").HasMaxLength(32);
            e.Property(x => x.Title).HasColumnName("title").HasMaxLength(128);
            e.Property(x => x.TemplateId).HasColumnName("templateId").HasMaxLength(64);
            e.Property(x => x.Content).HasColumnName("content").HasColumnType("json")
             .HasConversion(new ResumeContentConverter());
            e.Property(x => x.AnalysisJson).HasColumnName("analysis").HasColumnType("json");
            e.Property(x => x.CreatedAt).HasColumnName("createdAt").HasColumnType("datetime(3)");
            e.Property(x => x.UpdatedAt).HasColumnName("updatedAt").HasColumnType("datetime(3)");
            e.HasIndex(x => x.UserId);
        });

    }

    /// <summary>对齐 Prisma @updatedAt：Resume 更新时自动刷新 UpdatedAt；新实体补默认 id/时间</summary>
    public override int SaveChanges()
    {
        Touch();
        return base.SaveChanges();
    }

    public override Task<int> SaveChangesAsync(CancellationToken ct = default)
    {
        Touch();
        return base.SaveChangesAsync(ct);
    }

    private void Touch()
    {
        foreach (var entry in ChangeTracker.Entries<Resume>())
        {
            if (entry.State == EntityState.Modified) entry.Entity.UpdatedAt = DateTime.Now;
            if (entry.State == EntityState.Added)
            {
                if (string.IsNullOrEmpty(entry.Entity.Id)) entry.Entity.Id = Cuid.New();
                var now = DateTime.Now;
                entry.Entity.CreatedAt = now;
                entry.Entity.UpdatedAt = now;
            }
        }
        foreach (var entry in ChangeTracker.Entries<User>())
            if (entry.State == EntityState.Added && string.IsNullOrEmpty(entry.Entity.Id)) entry.Entity.Id = Cuid.New();
        foreach (var entry in ChangeTracker.Entries<AiModelProfile>())
            if (entry.State == EntityState.Added && string.IsNullOrEmpty(entry.Entity.Id)) entry.Entity.Id = Cuid.New();
        foreach (var entry in ChangeTracker.Entries<LlmCallLog>())
            if (entry.State == EntityState.Added && string.IsNullOrEmpty(entry.Entity.Id)) entry.Entity.Id = Cuid.New();
    }
}
